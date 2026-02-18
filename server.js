
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
server.listen(PORT, () => {
  console.log('CardArena server (static + WS) running on port', PORT);
});

const rooms = {}; // roomId -> room
const clients = new Map(); // ws -> {playerId, name}

function genRoomCode(){return Math.random().toString(36).slice(2,8).toUpperCase()}

function send(ws, msg){
  try{ ws.send(JSON.stringify(msg)); }catch(e){}
}

function broadcastToRoom(roomId, msg){
  const room = rooms[roomId];
  if(!room) return;
  room.players.forEach(p=>{
    const client = Array.from(clients.entries()).find(([sock,info])=>info && info.playerId===p.id);
    if(client && client[0] && client[0].readyState===WebSocket.OPEN) send(client[0], msg);
  });
}

function broadcastRoomsList(){
  const publicRooms = Object.values(rooms).filter(r=>!r.private).reduce((acc,r)=>{acc[r.id]=r;return acc;},{});
  const msg = {type:'rooms_list', rooms: publicRooms};
  for(const [ws] of clients){ if(ws.readyState===WebSocket.OPEN) send(ws,msg); }
}

function createBot(){
  return {id:'bot_'+Math.random().toString(36).slice(2,8), name:'Bot_'+Math.floor(Math.random()*999), avatar:Math.floor(Math.random()*10), isBot:true, ready:true, diff:'medium'};
}

function safeRoomForBroadcast(room){
  // shallow copy without connections
  const r = Object.assign({}, room);
  r.players = (r.players||[]).map(p=>({id:p.id,name:p.name,avatar:p.avatar,isBot:!!p.isBot,ready:!!p.ready}));
  return r;
}

// WebSocket logic remains unchanged
wss.on('connection', (ws)=>{
  clients.set(ws, null);
  ws.on('message', (raw)=>{
    let msg;
    try{ msg = JSON.parse(raw); }catch(e){return}
    const {type, payload} = msg;
    switch(type){
      case 'identify':{
        const playerId = payload && payload.playerId;
        const name = payload && payload.name;
        clients.set(ws, {playerId, name});
        // Attach to any rooms where this playerId exists (reconnect)
        for(const r of Object.values(rooms)){
          const existing = r.players.find(p=>p.id===playerId);
          if(existing){
            // send joined_room to reconnecting socket
            send(ws,{type:'joined_room', room:safeRoomForBroadcast(r)});
            // notify others
            broadcastToRoom(r.id,{type:'room_updated', room:safeRoomForBroadcast(r)});
          }
        }
        // Send current rooms list immediately
        send(ws,{type:'rooms_list', rooms:Object.values(rooms).filter(r=>!r.private).reduce((a,r)=>{a[r.id]=safeRoomForBroadcast(r);return a;}, {})});
        break;
      }
      
      case 'list_rooms':
        send(ws,{type:'rooms_list', rooms:Object.values(rooms).filter(r=>!r.private).reduce((a,r)=>{a[r.id]=safeRoomForBroadcast(r);return a;}, {})});
        break;
      case 'create_room':{
        const info = clients.get(ws) || {};
        const owner = payload.ownerId || info.playerId;
        if(!owner || info.playerId!==owner){ send(ws,{type:'error', error:'not_authorized'}); break; }
        const id='room_'+Date.now();
        const code = genRoomCode();
        const ownerName = payload.ownerName||info.name||'Player';
        const room = {id, code, name:payload.name||ownerName+"'s Room", host:owner, maxPlayers:payload.maxPlayers||4, players:[{id:owner,name:ownerName,avatar:payload.avatar||0,isBot:false,ready:true}], status:'waiting', private:!!payload.private, password:payload.password||null, bots:[] };
        rooms[id]=room;
        send(ws,{type:'room_created', room:safeRoomForBroadcast(room)});
        broadcastRoomsList();
        break;
      }
      case 'join_room':{
        const roomId = payload.roomId;
        const player = payload.player;
        const room = rooms[roomId];
        if(!room){ send(ws,{type:'error', error:'room_not_found'}); break; }
        if(room.players.length>=room.maxPlayers){ send(ws,{type:'error', error:'room_full'}); break; }
        room.players.push(Object.assign({ready:false,isBot:false}, player));
        // Notify joining client directly
        send(ws,{type:'joined_room', room:safeRoomForBroadcast(room)});
        broadcastToRoom(roomId,{type:'room_updated', room:safeRoomForBroadcast(room)});
        broadcastRoomsList();
        break;
      }
      case 'join_by_code':{
        const code = payload.code;
        const player = payload.player;
        const room = Object.values(rooms).find(r=>r.code===code);
        if(!room){ send(ws,{type:'error', error:'room_not_found'}); break; }
        if(room.players.length>=room.maxPlayers){ send(ws,{type:'error', error:'room_full'}); break; }
        room.players.push(Object.assign({ready:false,isBot:false}, player));
        send(ws,{type:'joined_room', room:safeRoomForBroadcast(room)});
        broadcastToRoom(room.id,{type:'room_updated', room:safeRoomForBroadcast(room)});
        broadcastRoomsList();
        break;
      }
      case 'leave_room':{
        const {roomId, playerId} = payload;
        const room = rooms[roomId];
        if(room){
          // send confirmation to leaving client if connected
          const leaverSock = Array.from(clients.entries()).find(([s,info])=>info && info.playerId===playerId);
          if(leaverSock && leaverSock[0] && leaverSock[0].readyState===WebSocket.OPEN){ send(leaverSock[0], {type:'left_room', room:safeRoomForBroadcast(room), playerId}); }
          room.players = room.players.filter(p=>p.id!==playerId);
          broadcastToRoom(roomId,{type:'room_updated', room:safeRoomForBroadcast(room)});
          broadcastRoomsList();
        }
        break;
      }
      case 'chat':{
        const {roomId, from, text} = payload; broadcastToRoom(roomId,{type:'chat', from, text}); break;
      }
      case 'play_cards':{
        const {roomId, playerId, cardIds, claimedRank} = payload;
        const room = rooms[roomId];
        if(!room){ send(ws,{type:'error', error:'room_not_found'}); break; }
        // Broadcast to room
        broadcastToRoom(roomId, {type:'player_played', roomId, playerId, cardIds, claimedRank});
        break;
      }
      case 'pass':{
        const {roomId, playerId} = payload; const room=rooms[roomId]; if(!room){ send(ws,{type:'error', error:'room_not_found'}); break; } broadcastToRoom(roomId, {type:'player_passed', roomId, playerId}); break;
      }
      case 'check':{
        const {roomId, playerId} = payload; const room=rooms[roomId]; if(!room){ send(ws,{type:'error', error:'room_not_found'}); break; } broadcastToRoom(roomId, {type:'player_checked', roomId, playerId}); break;
      }
      case 'player_ready':{
        const {roomId, playerId, ready} = payload; const room=rooms[roomId]; if(room){ const p=room.players.find(x=>x.id===playerId); if(p) p.ready=ready; broadcastToRoom(roomId,{type:'room_updated', room:safeRoomForBroadcast(room)}); broadcastRoomsList(); } break;
      }
      case 'add_bot':{
        const {roomId, diff} = payload; const room=rooms[roomId]; if(room && room.players.length<room.maxPlayers){ const bot=createBot(); bot.diff=diff||'medium'; room.players.push(bot); broadcastToRoom(roomId,{type:'room_updated', room:safeRoomForBroadcast(room)}); broadcastRoomsList(); } break;
      }
      case 'kick_player':{
        const {roomId, playerId} = payload; const room=rooms[roomId];
        const info = clients.get(ws) || {};
        if(!room){ send(ws,{type:'error', error:'room_not_found'}); break; }
        if(room.host!==info.playerId){ send(ws,{type:'error', error:'not_authorized'}); break; }
        if(room){ room.players=room.players.filter(p=>p.id!==playerId); broadcastToRoom(roomId,{type:'room_updated', room:safeRoomForBroadcast(room)}); broadcastRoomsList(); }
        break;
      }
      case 'start_game':{
        const roomId = payload.roomId; const room=rooms[roomId]; const info = clients.get(ws) || {};
        if(!room){ send(ws,{type:'error', error:'room_not_found'}); break; }
        if(room.host!==info.playerId){ send(ws,{type:'error', error:'not_authorized'}); break; }
        if(room){
          // Server-side authoritative deck and dealing
          const deck = [];
          const SUITS = ['♠','♥','♦','♣'];
          const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
          for(const s of SUITS) for(const r of RANKS) deck.push({rank:r,suit:s,id:r+s});
          // shuffle
          for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}
          // deal
          const n = room.players.length;
          const hands = {};
          for(let i=0;i<n;i++) hands[room.players[i].id]=[];
          deck.forEach((c,i)=>{ hands[ room.players[i % n].id ].push(c); });
          // mark room playing
          room.status='playing';
          // Broadcast start with hands mapping (clients may handle visibility)
          broadcastToRoom(roomId,{type:'start_game', roomId, players: room.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,isBot:!!p.isBot})), starterId: room.host, hands});
        }
        break;
      }
    }
  });

  ws.on('close', ()=>{
    const info = clients.get(ws);
    if(info && info.playerId){
      // remove player from any rooms
      for(const r of Object.values(rooms)){
        if(r.players.find(p=>p.id===info.playerId)){
          r.players = r.players.filter(p=>p.id!==info.playerId);
          broadcastToRoom(r.id,{type:'left_room', room:safeRoomForBroadcast(r), playerId:info.playerId});
        }
      }
      broadcastRoomsList();
    }
    clients.delete(ws);
  });

  // allow client to identify itself
  ws.on('error', ()=>{});
});


process.on('SIGINT', ()=>{ console.log('Shutting down'); server.close(()=>process.exit(0)); });
