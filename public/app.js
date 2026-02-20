// ============================================================
// GLOBAL STATE
// ============================================================
const AVATARS = ['😎','🤠','🎭','🦊','🐱','🎩','🤡','🦁','🐸','🎪'];
const BOT_NAMES = ['Ace','Bluffmaster','CardShark','Dealer','Enigma','Falcon','Ghost','Hustle','Ironside','Joker','King','Lancer'];
const HUMAN_NAMES = ['Ava','Liam','Mia','Noah','Ella','Leo','Zoe','Ethan','Ivy','Mason','Luna','Owen'];
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const RED_SUITS = ['♥','♦'];
const TIMER_DURATION = 30;

let settings = {name:'Player',avatar:0,sound:true,anim:true,autoReady:false};
let selectedDiff = 'easy';
let selectedAvatar = 0;

// Online simulation state
let rooms = {};
let myRoomId = null;
let myPlayerId = localStorage.getItem('cardArenaPlayerId') || ('p_' + Math.random().toString(36).slice(2,8));
localStorage.setItem('cardArenaPlayerId', myPlayerId);
let isHost = false;
let isReady = false;

// Game state
let G = null; // game instance
let myTurnTimer = null;

// ============================================================
// SCREEN NAV
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if(id==='lobbyScreen') refreshRooms();
}

// ============================================================
// ANIMATED HOME BACKGROUND
// ============================================================
(function initHomeBg(){
  const bg = document.getElementById('homeBg');
  for(let i=0;i<12;i++){
    const el = document.createElement('div');
    el.className='floating-card';
    el.textContent=SUITS[i%4];
    el.style.left=Math.random()*100+'%';
    el.style.animationDelay=-Math.random()*15+'s';
    el.style.animationDuration=(10+Math.random()*15)+'s';
    el.style.fontSize=(1.5+Math.random()*2)+'rem';
    bg.appendChild(el);
  }
})();

// ============================================================
// SETTINGS
// ============================================================
function selectAvatar(i){
  selectedAvatar=i;
  document.querySelectorAll('[id^=av]').forEach((el,j)=>el.style.borderColor=j===i?'var(--teal)':'var(--border)');
}
function saveSettings(){
  settings.name=document.getElementById('settingsName').value||'Player';
  settings.avatar=selectedAvatar;
  settings.sound=document.getElementById('toggleSound').classList.contains('on');
  settings.anim=document.getElementById('toggleAnim').classList.contains('on');
  settings.autoReady=document.getElementById('toggleAutoReady').classList.contains('on');
  toast('Settings saved!','green');
  setTimeout(()=>showScreen('homeScreen'),500);
}

// ============================================================
// DIFFICULTY
// ============================================================
function selectDiff(d,el){
  selectedDiff=d;
  document.querySelectorAll('.diff-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
}

// ============================================================
// LOBBY / ROOMS (simulated)
// ============================================================
function genRoomCode(){return Math.random().toString(36).slice(2,8).toUpperCase()}
// WebSocket-based multiplayer client (server required at WS_URL)

let ws = null;
let serverRooms = {};
// Dynamically determine WS URL for local/dev/prod
function getWebSocketUrl() {
  // Allow override for debugging
  const override = localStorage.getItem('cardArenaServer');
  if (override) return override;
  let protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let host = window.location.hostname;
  let port = window.location.port;
  // If running on Railway or similar, use same host/port as page
  let wsUrl = protocol + '//' + host + (port ? ':' + port : '') + '/';
  return wsUrl;
}

const WS_URL = getWebSocketUrl();
console.log('Connecting to WebSocket server at', WS_URL);
function connectToServer(){
  try{
    ws = new WebSocket(WS_URL);
  }catch(e){
    toast('WebSocket init failed','red');
    showOfflineBanner(true);
    return;
  }
  ws.onopen = ()=>{
    toast('Connected to server','green');
    showOfflineBanner(false);
    ws.send(JSON.stringify({type:'identify', payload:{playerId:myPlayerId, name:settings.name}}));
    ws.send(JSON.stringify({type:'list_rooms'}));
  };
  ws.onmessage = (ev)=>{ try{ const msg=JSON.parse(ev.data); handleServerMessage(msg);}catch(e){} };
  ws.onclose = ()=>{
    toast('Disconnected from server — offline mode','gold');
    showOfflineBanner(true);
    setTimeout(()=>connectToServer(),3000);
  };
  ws.onerror = ()=>{
    toast('WebSocket error','red');
    showOfflineBanner(true);
    if(ws)ws.close();
  };
}

function showOfflineBanner(show) {
  const banner = document.getElementById('offlineBanner');
  if (banner) banner.style.display = show ? 'block' : 'none';
}

function handleServerMessage(msg){
  switch(msg.type){
    case 'error':
      toast(msg.error||'Server error','red');
      break;
    case 'rooms_list':
      serverRooms = msg.rooms || {};
      rooms = Object.assign({}, serverRooms);
      refreshRooms();
      break;
    case 'room_created':
      if(msg.room) rooms[msg.room.id]=msg.room;
      refreshRooms();
      // server uses `host` field for owner id
      if(msg.room && msg.room.host===myPlayerId){ myRoomId=msg.room.id; isHost=true; showWaitingRoom(msg.room.id); }
      break;
    case 'room_updated':
      if(msg.room) rooms[msg.room.id]=msg.room;
      if(myRoomId===msg.room.id){ renderSeats(); renderWaitPlayers(); }
      refreshRooms();
      break;
    case 'player_played':
      // payload: {playerId, cardIds, claimedRank}
      if(msg.roomId===myRoomId && msg.playerId){ applyPlay(msg.playerId, msg.cardIds, msg.claimedRank); }
      break;
    case 'player_passed':
      if(msg.roomId===myRoomId && msg.playerId){ const idx=G.players.findIndex(p=>p.id===msg.playerId); if(idx!==-1){ executePass(idx); } }
      break;
    case 'player_checked':
      if(msg.roomId===myRoomId && msg.playerId){ resolveCheck(msg.playerId); }
      break;
    case 'joined_room':
      if(msg.room) rooms[msg.room.id]=msg.room;
      myRoomId=msg.room.id; isHost=(msg.room.host===myPlayerId);
      showWaitingRoom(msg.room.id);
      break;
    case 'left_room':
      // If server notifies we left, clear local state and go home
      if(msg.playerId===myPlayerId){ myRoomId=null; isHost=false; isReady=false; showScreen('homeScreen'); toast('Left room','teal'); }
      else if(msg.room){ rooms[msg.room.id]=msg.room; renderSeats(); renderWaitPlayers(); }
      break;
    case 'chat':
      addWaitChat(msg.from||'', msg.text||'', 'action');
      break;
    case 'start_game':
      if(msg.roomId===myRoomId && msg.players) initGame(msg.players, msg.starterId, msg.hands);
      break;
  }
}

// Start websocket connection
connectToServer();

function lobbyTab(tab,el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('lobbyBrowse').style.display=tab==='browse'?'block':'none';
  document.getElementById('lobbyCreate').style.display=tab==='create'?'block':'none';
  document.getElementById('lobbyJoin').style.display=tab==='join'?'block':'none';
}

function refreshRooms(){
  const list=document.getElementById('roomList');
  const waitingRooms=Object.values(rooms).filter(r=>!r.private&&r.status==='waiting'&&r.host!==myPlayerId);
  document.getElementById('roomCountLabel').textContent=waitingRooms.length+' public rooms available';
  list.innerHTML='';
  if(!waitingRooms.length){list.innerHTML='<div style="color:var(--text3);text-align:center;padding:20px">No open rooms. Create one!</div>';return;}
  waitingRooms.forEach(room=>{
    const el=document.createElement('div');
    el.className='room-item';
    el.innerHTML=`
      <div>
        <div class="name">${esc(room.name)}</div>
        <div class="info">${room.players.length}/${room.maxPlayers} players · ${room.bots.length} bots</div>
      </div>
      <span class="badge badge-${room.status}">${room.status}</span>
      <button class="btn btn-secondary btn-sm" onclick="joinRoom('${room.id}',event)">Join</button>`;
    list.appendChild(el);
  });
}

function createRoom(){
  const name=document.getElementById('createRoomName').value||settings.name+"'s Room";
  const maxP=+document.getElementById('createMaxPlayers').value;
  const botSlots=+document.getElementById('createBotSlots').value;
  const priv=document.getElementById('privToggle').classList.contains('on');
  const pwd=priv?document.getElementById('createRoomPwd').value:null;
  // If connected to server, request room creation there
  if(ws && ws.readyState===1){
    ws.send(JSON.stringify({type:'create_room', payload:{name, maxPlayers:maxP, botSlots, private:priv, password:pwd, ownerId:myPlayerId, ownerName:settings.name, avatar:settings.avatar}}));
    toast('Creating room on server...','teal');
    return;
  }
  // Fallback to local room creation
  const id='room_mine_'+Date.now();
  const code=genRoomCode();
  const bots=[...Array(botSlots)].map((_,i)=>makeBot('medium'));
  rooms[id]={
    id,code,name,host:myPlayerId,
    maxPlayers:maxP,
    players:[{id:myPlayerId,name:settings.name,avatar:settings.avatar,isBot:false,ready:settings.autoReady},...bots],
    status:'waiting',private:priv,password:pwd,bots
  };
  myRoomId=id; isHost=true; isReady=settings.autoReady;
  showWaitingRoom(id);
}

function joinRoom(roomId,evt){
  if(evt)evt.stopPropagation();
  // If server connected, request join via server
  if(ws && ws.readyState===1){
    ws.send(JSON.stringify({type:'join_room', payload:{roomId, player:{id:myPlayerId,name:settings.name,avatar:settings.avatar}}}));
    toast('Joining room...','teal');
    return;
  }
  const room=rooms[roomId];
  if(!room)return toast('Room not found','red');
  if(room.players.length>=room.maxPlayers)return toast('Room is full','red');
  if(room.status==='playing')return toast('Game already started','red');
  room.players.push({id:myPlayerId,name:settings.name,avatar:settings.avatar,isBot:false,ready:settings.autoReady});
  myRoomId=roomId; isHost=false; isReady=settings.autoReady;
  showWaitingRoom(roomId);
}

function joinByCode(){
  const code=document.getElementById('joinCode').value.toUpperCase().trim();
  // If connected to server, ask server to join by code
  if(ws && ws.readyState===1){
    ws.send(JSON.stringify({type:'join_by_code', payload:{code, player:{id:myPlayerId,name:settings.name,avatar:settings.avatar}}}));
    toast('Joining room by code...','teal');
    return;
  }
  const room=Object.values(rooms).find(r=>r.code===code);
  if(!room)return toast('Room not found','red');
  joinRoom(room.id,null);
}

function makeBot(diff){
  const id='bot_'+Math.random().toString(36).slice(2,8);
  const name=BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)]+(Math.random()>0.5?'_'+Math.floor(Math.random()*99):'');
  return {id,name,avatar:Math.floor(Math.random()*10),isBot:true,ready:true,diff};
}

// ============================================================
// WAITING ROOM
// ============================================================
function showWaitingRoom(roomId){
  const room=rooms[roomId];
  document.getElementById('waitRoomName').textContent=room.name;
  document.getElementById('waitRoomCode').textContent=room.code;
  document.getElementById('startGameBtn').style.display=isHost?'flex':'none';
  document.getElementById('hostControls').style.display=isHost?'flex':'none';
  document.getElementById('readyBtn').textContent=isReady?'✓ Ready':'○ Not Ready';
  document.getElementById('readyBtn').className=isReady?'btn btn-gold':'btn btn-secondary';
  renderSeats();
  renderWaitPlayers();
  addWaitChat('','Joined room! Say hello 👋','system');
  showScreen('waitingScreen');
  // Simulate bots readying up after delay
  setTimeout(()=>{
    if(rooms[roomId])rooms[roomId].players.forEach(p=>{if(p.isBot)p.ready=true});
    renderSeats(); renderWaitPlayers();
  },1500);
}

function renderSeats(){
  const ring=document.getElementById('seatRing');
  ring.innerHTML='';
  const room=rooms[myRoomId];
  if(!room)return;
  const n=room.maxPlayers;
  const players=[...room.players];
  // Pad with empty slots
  while(players.length<n)players.push(null);
  const cx=170,cy=170,rx=130,ry=130;
  players.forEach((p,i)=>{
    const angle=(2*Math.PI*i/n)-Math.PI/2;
    const x=cx+rx*Math.cos(angle);
    const y=cy+ry*Math.sin(angle);
    const el=document.createElement('div');
    el.className='seat'+(p?'':" seat-empty");
    el.style.left=x+'px'; el.style.top=y+'px';
    if(p){
      const isMe=p.id===myPlayerId;
      const isRoomHost=p.id===room.host;
      el.innerHTML=`
        <div class="seat-avatar${isMe?' me':''}${isRoomHost?' host-seat':''}${p.ready?' ready':''}">
          ${AVATARS[p.avatar%AVATARS.length]}
          ${isRoomHost?'<span class="crown">👑</span>':''}
        </div>
        <div class="seat-name">${esc(p.name)}${p.isBot?'🤖':''}</div>
        <div class="seat-status ${p.ready?'ready':'not-ready'}">${p.ready?'READY':'WAITING'}</div>
        ${isHost&&!isMe?`<button class="btn btn-danger btn-xs" onclick="kickPlayer('${p.id}')">Kick</button>`:''}`;
    } else {
      el.innerHTML=`<div class="seat-avatar"><span style="font-size:1.5rem;color:var(--text3)">+</span></div><div class="seat-name" style="color:var(--text3)">Empty</div>`;
    }
    ring.appendChild(el);
  });
}

function renderWaitPlayers(){
  const list=document.getElementById('waitPlayerList');
  const room=rooms[myRoomId];
  if(!room){list.innerHTML='';return;}
  list.innerHTML=room.players.map(p=>`
    <div class="pl-item${p.id===room.host?' active':''}">
      <span class="emoji">${AVATARS[p.avatar%AVATARS.length]}</span>
      <div class="info">
        <div class="pname">${esc(p.name)}${p.isBot?' 🤖':''}${p.id===room.host?' 👑':''}</div>
        <div class="pcards">${p.ready?'✅ Ready':'⏳ Waiting'}</div>
      </div>
    </div>`).join('');
}

function toggleReady(){
  isReady=!isReady;
  const room=rooms[myRoomId];
  if(room){const me=room.players.find(p=>p.id===myPlayerId);if(me)me.ready=isReady;}
  document.getElementById('readyBtn').textContent=isReady?'✓ Ready':'○ Not Ready';
  document.getElementById('readyBtn').className=isReady?'btn btn-gold':'btn btn-secondary';
  renderSeats(); renderWaitPlayers();
  // Notify server
  if(ws && ws.readyState===1 && myRoomId){
    ws.send(JSON.stringify({type:'player_ready', payload:{roomId:myRoomId, playerId:myPlayerId, ready:isReady}}));
  }
}

function hostAddBot(){
  const room=rooms[myRoomId];
  if(!room||room.players.length>=room.maxPlayers)return toast('Room is full','red');
  const diff=document.getElementById('botDiffSelect').value;
  if(ws && ws.readyState===1){
    ws.send(JSON.stringify({type:'add_bot', payload:{roomId:myRoomId, diff}}));
    toast('Requesting server to add bot...','teal');
    return;
  }
  const bot=makeBot(diff);
  room.players.push(bot);
  renderSeats(); renderWaitPlayers();
  addWaitChat('','🤖 '+bot.name+' ('+diff+') joined the room','system');
}

function kickPlayer(pid){
  const room=rooms[myRoomId];
  if(!room)return;
  if(ws && ws.readyState===1){
    ws.send(JSON.stringify({type:'kick_player', payload:{roomId:myRoomId, playerId:pid}}));
    toast('Requesting server to kick player...','teal');
    return;
  }
  room.players=room.players.filter(p=>p.id!==pid);
  renderSeats(); renderWaitPlayers();
  toast('Player kicked','gold');
}

function addWaitChat(who,msg,type='action'){
  const div=document.getElementById('waitChat');
  const el=document.createElement('div');
  el.className='chat-msg '+(type==='system'?'system':'');
  el.innerHTML=type==='system'?`<em>${esc(msg)}</em>`:`<span class="who">${esc(who)}:</span> ${esc(msg)}`;
  div.appendChild(el);
  div.scrollTop=div.scrollHeight;
  // Also mirror waiting-room chat into game chat (read-only view in game)
  const gdiv = document.getElementById('gameChat');
  if(gdiv){
    const gel = el.cloneNode(true);
    gdiv.appendChild(gel);
    gdiv.scrollTop = gdiv.scrollHeight;
  }
}
function sendWaitChat(){
  const inp=document.getElementById('waitChatInput');
  if(!inp.value.trim())return;
  const text=inp.value.trim();
  if(ws && ws.readyState===1 && myRoomId){
    ws.send(JSON.stringify({type:'chat', payload:{roomId:myRoomId, from:settings.name, text}}));
  } else {
    addWaitChat(settings.name,text,'action');
  }
  inp.value='';
}

// Send a chat message from the in-game chat input
function sendGameChat(){
  const inp = document.getElementById('gameChatInput');
  if(!inp || !inp.value.trim()) return;
  const text = inp.value.trim();
  if(ws && ws.readyState===1 && myRoomId){
    ws.send(JSON.stringify({type:'chat', payload:{roomId:myRoomId, from:settings.name, text}}));
  } else {
    // Offline fallback: add to waiting chat (which mirrors to game chat)
    addWaitChat(settings.name, text, 'action');
  }
  inp.value='';
}

function copyRoomCode(){
  const code=document.getElementById('waitRoomCode').textContent;
  navigator.clipboard.writeText(code).catch(()=>{});
  toast('Room code copied: '+code,'teal');
}

function startGame(){
  const room=rooms[myRoomId];
  if(!room)return;
  if(room.players.length<2)return toast('Need at least 2 players!','red');
  const nonBotPlayers=room.players.filter(p=>!p.isBot);
  // Check all non-bot players ready
  if(!nonBotPlayers.every(p=>p.id===myPlayerId?isReady:p.ready))return toast('Not all players are ready!','gold');
  // If connected, ask server to start the game so all clients receive start message
  if(ws && ws.readyState===1 && isHost){
    ws.send(JSON.stringify({type:'start_game', payload:{roomId:myRoomId}}));
    toast('Requesting server to start game...','teal');
    return;
  }
  initGame(room.players);
}

function leaveRoom(){
  const room=rooms[myRoomId];
  if(ws && ws.readyState===1 && myRoomId){
    // Optimistically update UI for quick feedback; server will confirm
    ws.send(JSON.stringify({type:'leave_room', payload:{roomId:myRoomId, playerId:myPlayerId}}));
    myRoomId=null; isHost=false; isReady=false; showScreen('homeScreen');
    return;
  }
  if(room){room.players=room.players.filter(p=>p.id!==myPlayerId);} 
  myRoomId=null; isHost=false; isReady=false;
  showScreen('homeScreen');
}

// ============================================================
// SINGLE PLAYER
// ============================================================
function startSinglePlayer(){
  const n=+document.getElementById('botCount').value;
  const diff=selectedDiff;
  const name=document.getElementById('spPlayerName').value||settings.name;
  const diffs=['easy','medium','hard'];
  const bots=[...Array(n)].map((_,i)=>{
    const d=diff==='mixed'?diffs[i%3]:diff;
    return makeBot(d);
  });
  const players=[{id:myPlayerId,name,avatar:settings.avatar,isBot:false,ready:true},...bots];
  initGame(players);
}

// ============================================================
// GAME ENGINE
// ============================================================
function buildDeck(){
  const deck=[];
  for(const suit of SUITS)for(const rank of RANKS)deck.push({rank,suit,id:rank+suit});
  return deck;
}
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}
  return arr;
}
function dealCards(deck,n){
  const hands=Array.from({length:n},()=>[]);
  deck.forEach((c,i)=>hands[i%n].push(c));
  return hands;
}
function nextRank(r){return RANKS[(RANKS.indexOf(r)+1)%RANKS.length];}

// Sort a hand array by rank (A,2,3...K) then by suit (♠♥♦♣)
function sortHand(hand){
  const SUIT_ORDER={'♠':0,'♥':1,'♦':2,'♣':3};
  return hand.slice().sort((a,b)=>{
    const ri=RANKS.indexOf(a.rank)-RANKS.indexOf(b.rank);
    if(ri!==0)return ri;
    return (SUIT_ORDER[a.suit]||0)-(SUIT_ORDER[b.suit]||0);
  });
}

function initGame(players, starterId, handsMap){
  // If server provided handsMap, use it (authoritative). Otherwise, build & deal locally.
  let hands = null;
  if(handsMap){
    hands = players.map(p => (handsMap[p.id]||[]));
  } else {
    const deck=shuffle(buildDeck());
    hands=dealCards(deck,players.length);
  }
  G = {
    players: players.map((p,i)=>({...p,hand:sortHand(hands[i]),handCount:hands[i].length})),
    // pile: accumulated face-down plays this round [{playerId,cards,claimedRank,count}]
    pile: [],
    // pileCards: flat list of all cards in the pile (for count display)
    pileCards: [],
    currentPlayerIdx: 0,
    // roundRank: the locked rank for the current round (null = round start, free choice)
    roundRank: null,
    // lastContributorIdx: index of last player who actually played cards this round
    lastContributorIdx: null,
    // consecutivePasses: counts passes since last card-play; used for all-pass detection
    consecutivePasses: 0,
    // lastPlay: the most recent card-play entry {playerId,cards,claimedRank,count,playerIdx}
    lastPlay: null,
    // roundStarterIdx: who starts the new round (gets free rank choice)
    roundStarterIdx: 0,
    log: [],
    paused: false,
    winner: null,
    turnTimer: TIMER_DURATION,
    timerInterval: null,
  };
  // If server provided a starterId, set currentPlayerIdx accordingly
  if(starterId){
    const idx = players.findIndex(p=>p.id===starterId);
    if(idx!==-1) G.currentPlayerIdx = idx;
  }
  document.getElementById('gameRoomInfo').textContent=rooms[myRoomId]?rooms[myRoomId].name:'Singleplayer';
  showScreen('gameScreen');
  renderGame();
  startTurn();
}

function renderGame(){
  if(!G)return;
  renderTablePlayers();
  renderHand();
  renderPile();
  renderGamePlayers();
  renderGameLog();
  updateTurnInfo();
  updateRoundStrip();
}

function renderTablePlayers(){
  const el=document.getElementById('tablePlayers');
  el.innerHTML='';
  const n=G.players.length;
  const felt=document.getElementById('tableFelt');
  const W=felt.offsetWidth||580, H=felt.offsetHeight||480;
  const cx=W/2, cy=H/2;
  const rx=cx*0.75, ry=cy*0.70;
  // Rotate the seating so the local player is always at the bottom (angle = +PI/2)
  const myIdx = G.players.findIndex(p => p.id===myPlayerId);
  G.players.forEach((p,i)=>{
    const rel = myIdx===-1 ? i : (i - myIdx);
    const angle=(2*Math.PI*rel/n)+Math.PI/2;
    const x=cx+rx*Math.cos(angle);
    const y=cy+ry*Math.sin(angle);
    const isMe=p.id===myPlayerId;
    const isActive=i===G.currentPlayerIdx;
    const div=document.createElement('div');
    div.className='table-player';
    div.style.left=x+'px'; div.style.top=y+'px';
    div.innerHTML=`
      <div class="tp-avatar${isActive?' active-turn':''}${isMe?' me':''}">
        ${AVATARS[p.avatar%AVATARS.length]}
        <span class="card-count-badge">${p.handCount}</span>
      </div>
      <div class="tp-name">${esc(p.name)}${p.isBot?'🤖':''}</div>
      <div class="tp-cards">${[...Array(Math.min(p.handCount,8))].map(()=>'<div class="tp-card-back"></div>').join('')}</div>`;
    el.appendChild(div);
  });
}

function renderHand(){
  const me=G.players.find(p=>p.id===myPlayerId);
  if(!me){document.getElementById('handCards').innerHTML='';return;}
  document.getElementById('myHandCount').textContent=me.hand.length;
  const isMyTurn=G.players[G.currentPlayerIdx].id===myPlayerId;
  document.getElementById('myTurnBadge').style.display=isMyTurn?'block':'none';
  // Show play actions only on my turn
  document.getElementById('handActions').style.display=(isMyTurn)?'flex':'none';
  // Rank select: free choice at round start, locked otherwise
  const sel=document.getElementById('rankSelect');
  const isRoundStart=(G.roundRank===null);
  if(isRoundStart){
    sel.innerHTML=RANKS.map(r=>`<option value="${r}">${r}</option>`).join('');
    sel.disabled=false;
    sel.title='Choose the rank for this round';
  } else {
    sel.innerHTML=`<option value="${G.roundRank}">${G.roundRank} (locked)</option>`;
    sel.disabled=true;
    sel.title='Rank is locked for this round';
  }
  const hc=document.getElementById('handCards');
  hc.innerHTML='';
  me.hand=sortHand(me.hand);
  me.hand.forEach(card=>{
    const isRed=RED_SUITS.includes(card.suit);
    const el=document.createElement('div');
    el.className='card'+(isRed?' red':' black');
    el.dataset.id=card.id;
    el.innerHTML=`<span class="rank-top">${card.rank}</span><span class="suit-center">${card.suit}</span><span class="rank-bot">${card.rank}</span>`;
    el.onclick=()=>toggleCardSelect(el,card.id,isMyTurn);
    hc.appendChild(el);
  });
}

function toggleCardSelect(el,cardId,isMyTurn){
  if(!isMyTurn)return;
  const selected=document.querySelectorAll('.card.selected');
  if(el.classList.contains('selected')){el.classList.remove('selected');return;}
  if(selected.length>=4)return toast('Max 4 cards per play','gold');
  el.classList.add('selected');
}

function renderPile(){
  const pc=document.getElementById('pileCards');
  const count=G.pileCards.length;
  document.getElementById('pileCount').textContent=count+' card'+(count!==1?'s':'');
  if(count===0){
    pc.innerHTML='<div class="pile-empty">Empty</div>';
    document.getElementById('lastPlayLabel').textContent='Pile is empty';
    return;
  }
  pc.innerHTML='';
  for(let i=0;i<Math.min(count,3);i++){const d=document.createElement('div');d.className='pile-card';d.style.zIndex=i;pc.appendChild(d);}
  if(G.lastPlay){
    const lp=G.lastPlay;
    const pname=G.players.find(p=>p.id===lp.playerId)?.name||'?';
    document.getElementById('lastPlayLabel').textContent=`${pname} played ${lp.count} × "${lp.claimedRank}"`;
  }
}

function renderGamePlayers(){
  const el=document.getElementById('gamePlayers');
  el.innerHTML=G.players.map((p,i)=>`
    <div class="pl-item${i===G.currentPlayerIdx?' active':''}">
      <span class="emoji">${AVATARS[p.avatar%AVATARS.length]}</span>
      <div class="info">
        <div class="pname">${esc(p.name)}${p.isBot?'🤖':''}</div>
        <div class="pcards">${p.handCount} cards${i===G.currentPlayerIdx?' · Playing...':''}</div>
      </div>
    </div>`).join('');
}

function renderGameLog(){
  const el=document.getElementById('gameLog');
  el.innerHTML=G.log.map(e=>`<div class="log-entry ${e.type}">${e.text}</div>`).join('');
  el.scrollTop=el.scrollHeight;
}

function addLog(text,type='action'){
  if(!G)return;
  G.log.push({text,type});
  if(G.log.length>100)G.log.shift();
  renderGameLog();
}

function updateRoundStrip(){
  const strip=document.getElementById('roundStatusStrip');
  if(!strip)return;
  if(G.roundRank){
    strip.style.display='block';
    const contrib=G.lastContributorIdx!==null?G.players[G.lastContributorIdx].name:'—';
    strip.textContent=`Round rank: ${G.roundRank}  ·  Last to play: ${contrib}  ·  Passes in a row: ${G.consecutivePasses}`;
  } else {
    strip.style.display='block';
    strip.textContent='New round — choose any rank to start';
    strip.style.color='var(--teal)';
    strip.style.borderColor='rgba(0,229,200,0.25)';
    strip.style.background='rgba(0,229,200,0.06)';
  }
}

function updateTurnInfo(){
  if(!G)return;
  const p=G.players[G.currentPlayerIdx];
  const isMe=p.id===myPlayerId;
  const rankLabel=G.roundRank?`Locked: <strong style="color:var(--gold)">${G.roundRank}</strong>`:`<strong style="color:var(--teal)">Free choice</strong>`;
  document.getElementById('turnInfo').innerHTML=`
    <span>Rank: ${rankLabel}</span>
    <span class="whose-turn">${isMe?'Your turn':p.name+"'s turn"}</span>
    <div class="timer-ring">
      <svg width="28" height="28" viewBox="0 0 28 28">
        <circle cx="14" cy="14" r="11" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="3"/>
        <circle id="timerCircle" cx="14" cy="14" r="11" fill="none" stroke="${isMe?'var(--gold)':'var(--teal2)'}" stroke-width="3"
          stroke-dasharray="${2*Math.PI*11}" stroke-dashoffset="${2*Math.PI*11*(1-G.turnTimer/TIMER_DURATION)}"/>
      </svg>
      <div class="timer-text" id="timerText">${G.turnTimer}</div>
    </div>`;
  // Check button: only active on my turn, if there's a last play that isn't mine
  const canCheck=isMe&&G.lastPlay&&G.lastPlay.playerId!==myPlayerId;
  const checkBtn=document.getElementById('checkBtn');
  checkBtn.disabled=!canCheck;
  if(canCheck)checkBtn.classList.add('pulse');
  else checkBtn.classList.remove('pulse');
  // Pass button: active on my turn, only after round has started (a play exists) or even at round start if I want to pass (though that skips the round start)
  const passBtn=document.getElementById('passBtn');
  // You can pass any time on your turn as long as the round has started (there's a pile)
  passBtn.disabled=!(isMe&&G.pileCards.length>0);
}

// ============================================================
// TURN MANAGEMENT
// ============================================================
function startTurn(){
  if(!G||G.winner)return;
  clearTurnTimer();
  G.turnTimer=TIMER_DURATION;
  const p=G.players[G.currentPlayerIdx];
  renderGame();
  G.timerInterval=setInterval(()=>{
    if(!G||G.paused)return;
    G.turnTimer--;
    const circle=document.getElementById('timerCircle');
    const text=document.getElementById('timerText');
    if(circle)circle.style.strokeDashoffset=2*Math.PI*11*(1-G.turnTimer/TIMER_DURATION);
    if(text)text.textContent=G.turnTimer;
    if(G.turnTimer<=0){clearTurnTimer();autoPlay();}
  },1000);
  if(p.isBot){
    const delay=1000+Math.random()*2500;
    setTimeout(()=>{if(G&&!G.winner&&G.currentPlayerIdx===G.players.indexOf(p))botTakeTurn(G.currentPlayerIdx);},delay);
  }
}

function clearTurnTimer(){
  if(G&&G.timerInterval){clearInterval(G.timerInterval);G.timerInterval=null;}
}

function autoPlay(){
  // Auto-pass if timer expires and there's a pile; else play a card
  const p=G.players[G.currentPlayerIdx];
  if(p.id!==myPlayerId)return;
  if(G.pileCards.length>0){
    callPass();
  } else if(p.hand.length>0){
    const el=document.querySelector('.card');
    if(el)el.classList.add('selected');
    playCards();
  }
}

// ============================================================
// PLAYER ACTIONS
// ============================================================
function playCards(){
  if(!G||G.winner)return;
  const p=G.players[G.currentPlayerIdx];
  if(p.id!==myPlayerId)return;
  const selected=[...document.querySelectorAll('.card.selected')].map(el=>el.dataset.id);
  if(selected.length===0)return toast('Select at least 1 card','gold');
  const rank=G.roundRank||document.getElementById('rankSelect').value;
  executePlay(G.currentPlayerIdx, selected.map(id=>p.hand.find(c=>c.id===id)), rank);
}

function executePlay(idx, cards, claimedRank){
  if(!G)return;
  const p=G.players[idx];
  // Lock the round rank on first play
  if(G.roundRank===null) G.roundRank=claimedRank;
  // Send play to server (server will broadcast to room)
  const cardIds = cards.map(c=>c.id);
  if(ws && ws.readyState===1 && myRoomId){
    ws.send(JSON.stringify({type:'play_cards', payload:{roomId:myRoomId, playerId:p.id, cardIds, claimedRank}}));
    addLog(`(pending) ${p.name} played ${cards.length} card${cards.length>1?'s':''} claiming "${claimedRank}"`, 'action');
    // Wait for server broadcast to apply play
    return;
  }
  // If no server, apply locally
  applyPlay(p.id, cardIds, claimedRank);
}

// Apply a play (used when server broadcasts or offline mode)
function applyPlay(playerId, cardIds, claimedRank){
  if(!G)return;
  const idx = G.players.findIndex(p=>p.id===playerId);
  if(idx===-1) return;
  const p = G.players[idx];
  // Lock the round rank on first play
  if(G.roundRank===null) G.roundRank=claimedRank;
  // Remove cards from hand
  const removed = [];
  cardIds.forEach(id=>{
    const card = p.hand.find(h=>h.id===id);
    if(card){ p.hand = p.hand.filter(h=>h.id!==id); removed.push(card); }
  });
  p.handCount = p.hand.length;
  // Add to pile
  G.pileCards.push(...removed);
  const entry={playerId: p.id, playerIdx: idx, cards: removed, claimedRank, count: removed.length};
  G.pile.push(entry);
  G.lastPlay = entry;
  G.lastContributorIdx = idx;
  G.consecutivePasses = 0;
  addLog(`${p.name} played ${removed.length} card${removed.length>1?'s':''} claiming "${claimedRank}"`, 'action');

  // Animate cards; then advance
  animateCardsToFile(idx, removed.length, ()=>{
    if(!G)return;
    if(p.hand.length===0){ endGame(idx); return; }
    G.currentPlayerIdx = (idx+1)%G.players.length;
    renderGame();
    startTurn();
  });
}

function resolveCheck(checkerId){
  if(!G||!G.lastPlay)return;
  const lp=G.lastPlay;
  const checkedPlayer=G.players.find(p=>p.id===lp.playerId);
  const checker=G.players.find(p=>p.id===checkerId);
  const wasLie=lp.cards.some(c=>c.rank!==lp.claimedRank);

  addLog(`🔍 ${checker.name} checks ${checkedPlayer.name}'s last play!`,'action');
  const revealStr=lp.cards.map(c=>c.rank+c.suit).join(', ');
  addLog(`Revealed: ${revealStr} (claimed "${lp.claimedRank}")`, wasLie?'bluff-caught':'bluff-wrong');

  let takerIdx, newStarterIdx, msg, type;
  if(wasLie){
    takerIdx=G.players.indexOf(checkedPlayer);
    newStarterIdx=G.players.indexOf(checker);
    msg=`🎯 CAUGHT! ${checkedPlayer.name} lied! They take ${G.pileCards.length} cards. ${checker.name} starts the new round.`;
    type='bluff-caught';
  } else {
    takerIdx=G.players.indexOf(checker);
    newStarterIdx=G.players.indexOf(checkedPlayer);
    msg=`❌ Honest! ${checkedPlayer.name} told the truth! ${checker.name} takes ${G.pileCards.length} cards. ${checkedPlayer.name} starts the new round.`;
    type='bluff-wrong';
  }
  addLog(msg,type);

  const pileCount=G.pileCards.length;

  // Show reveal animation first
  showRevealAnimation(lp.cards, lp.claimedRank, wasLie, checker.name, checkedPlayer.name, ()=>{
    if(!G)return;
    // Give pile to taker
    G.players[takerIdx].hand.push(...G.pileCards);
    G.players[takerIdx].hand=sortHand(G.players[takerIdx].hand);
    G.players[takerIdx].handCount=G.players[takerIdx].hand.length;

    // Animate penalty cards flying to taker
    animatePenaltyCards(takerIdx, pileCount, ()=>{
      if(!G)return;
      // Reset round state
      G.pileCards=[];
      G.pile=[];
      G.lastPlay=null;
      G.roundRank=null;
      G.consecutivePasses=0;
      G.lastContributorIdx=null;
      G.currentPlayerIdx=newStarterIdx;
      G.roundStarterIdx=newStarterIdx;
      renderGame();
      setTimeout(()=>startTurn(),400);
    });
  });
}

// ============================================================
// ANIMATION HELPERS
// ============================================================

/* Get the center {x,y} of a player's avatar on the table */
function getPlayerTablePos(idx){
  const felt=document.getElementById('tableFelt');
  if(!felt)return{x:window.innerWidth/2,y:window.innerHeight/2};
  const fr=felt.getBoundingClientRect();
  const n=G.players.length;
  const cx=fr.left+fr.width/2, cy=fr.top+fr.height/2;
  const rx=fr.width*0.375, ry=fr.height*0.35;
  const myIdx = G.players.findIndex(p => p.id===myPlayerId);
  const rel = myIdx===-1 ? idx : (idx - myIdx);
  const angle=(2*Math.PI*rel/n)+Math.PI/2;
  return {x:cx+rx*Math.cos(angle), y:cy+ry*Math.sin(angle)};
}

/* Get the center of the pile area */
function getPilePos(){
  const felt=document.getElementById('tableFelt');
  if(!felt)return{x:window.innerWidth/2,y:window.innerHeight/2};
  const fr=felt.getBoundingClientRect();
  return{x:fr.left+fr.width/2, y:fr.top+fr.height/2};
}

/* Animate N face-down cards flying from player position to pile */
function animateCardsToFile(playerIdx, count, callback){
  const from=getPlayerTablePos(playerIdx);
  const to=getPilePos();
  const DURATION=420;
  let done=0;
  const total=Math.min(count,4);
  for(let i=0;i<total;i++){
    const el=document.createElement('div');
    el.className='flying-card flying-card-back';
    const rot=(Math.random()-0.5)*30;
    el.style.cssText=`left:${from.x-22}px;top:${from.y-31}px;--fly-rot:${rot}deg;`;
    document.body.appendChild(el);
    const delay=i*60;
    setTimeout(()=>{
      const startX=from.x-22, startY=from.y-31;
      const endX=to.x-22,   endY=to.y-31;
      el.style.transition=`left ${DURATION}ms cubic-bezier(0.4,0,0.2,1),top ${DURATION}ms cubic-bezier(0.4,0,0.2,1),opacity ${DURATION}ms ease,transform ${DURATION}ms ease`;
      el.style.left=endX+'px';
      el.style.top=endY+'px';
      el.style.opacity='0';
      el.style.transform=`scale(0.6) rotate(${rot}deg)`;
      setTimeout(()=>{
        el.remove();
        done++;
        if(done===total){
          // Bounce the pile
          const pileEl=document.getElementById('pileCards');
          if(pileEl){pileEl.classList.remove('pile-bounce');void pileEl.offsetWidth;pileEl.classList.add('pile-bounce');setTimeout(()=>pileEl.classList.remove('pile-bounce'),400);}
          callback&&callback();
        }
      },DURATION+50);
    },delay);
  }
  if(total===0)callback&&callback();
}

/* Animate penalty cards flying from pile to player */
function animatePenaltyCards(playerIdx, count, callback){
  const from=getPilePos();
  const to=getPlayerTablePos(playerIdx);
  const DURATION=500;
  const total=Math.min(count,8);
  let done=0;
  // Flash the target player avatar
  const playerEls=document.querySelectorAll('.table-player');
  if(playerEls[playerIdx]){
    const av=playerEls[playerIdx].querySelector('.tp-avatar');
    if(av){av.classList.remove('avatar-pop');void av.offsetWidth;av.classList.add('avatar-pop');setTimeout(()=>av.classList.remove('avatar-pop'),600);}
  }
  for(let i=0;i<total;i++){
    const el=document.createElement('div');
    el.className='flying-card flying-card-back';
    const rot=(Math.random()-0.5)*40;
    el.style.cssText=`left:${from.x-22}px;top:${from.y-31}px;--fly-rot:${rot}deg;`;
    document.body.appendChild(el);
    const delay=i*50;
    setTimeout(()=>{
      const jitter=()=>(Math.random()-0.5)*20;
      el.style.transition=`left ${DURATION}ms cubic-bezier(0.4,0,0.2,1),top ${DURATION}ms cubic-bezier(0.4,0,0.2,1),opacity ${DURATION}ms ease,transform ${DURATION}ms ease`;
      el.style.left=(to.x-22+jitter())+'px';
      el.style.top=(to.y-31+jitter())+'px';
      el.style.opacity='0';
      el.style.transform=`scale(0.5) rotate(${rot*2}deg)`;
      setTimeout(()=>{
        el.remove();
        done++;
        if(done===total)callback&&callback();
      },DURATION+50);
    },delay);
  }
  if(total===0)callback&&callback();
}

/* Show the dramatic card reveal overlay */
function showRevealAnimation(cards, claimedRank, wasLie, checkerName, checkedName, callback){
  const overlay=document.createElement('div');
  overlay.className='reveal-overlay';
  const verdict=wasLie
    ?`💀 LIE! Not all "${claimedRank}"s`
    :`✅ TRUTH! Genuine "${claimedRank}"s`;
  const verdictClass=wasLie?'lie':'truth';
  const consequence=wasLie
    ?`${checkedName} takes the whole pile`
    :`${checkerName} takes the whole pile`;

  const cardsHTML=cards.map((c,i)=>{
    const isRed=['♥','♦'].includes(c.suit);
    return `<div class="reveal-card ${isRed?'red':'black'}" style="animation-delay:${0.3+i*0.12}s">
      <span style="font-size:0.8rem;font-weight:700">${c.rank}<br>${c.suit}</span>
      <span style="font-size:1.3rem;text-align:center">${c.suit}</span>
      <span style="font-size:0.8rem;font-weight:700;transform:rotate(180deg);display:block">${c.rank}</span>
    </div>`;
  }).join('');

  overlay.innerHTML=`
    <div class="reveal-backdrop"></div>
    <div class="reveal-spotlight"></div>
    <div class="reveal-panel">
      <div class="reveal-title">🔍 ${checkerName} checks ${checkedName}'s play<br><span style="font-size:0.8rem;color:var(--text2)">Claimed: "${claimedRank}"</span></div>
      <div class="reveal-cards-row">${cardsHTML}</div>
      <div class="reveal-verdict ${verdictClass}">${verdict}</div>
      <div class="reveal-result">${consequence}</div>
      <button class="btn btn-${wasLie?'primary':'secondary'}" style="margin-top:4px;padding:8px 24px" onclick="this.closest('.reveal-overlay').remove();const cb=window._revealCb;window._revealCb=null;cb&&cb()">Continue →</button>
    </div>`;
  window._revealCb=callback;
  document.body.appendChild(overlay);

  // Also auto-dismiss after 5s for bots
  const autoDismiss=setTimeout(()=>{
    if(overlay.parentNode){overlay.remove();const cb=window._revealCb;window._revealCb=null;cb&&cb();}
  },5000);
  overlay.querySelector('button').addEventListener('click',()=>clearTimeout(autoDismiss));
}

function callPass(){
  if(!G||G.winner)return;
  const myIdx=G.players.findIndex(p=>p.id===myPlayerId);
  if(G.currentPlayerIdx!==myIdx)return;
  clearTurnTimer();
  // send to server if available
  if(ws && ws.readyState===1 && myRoomId){ ws.send(JSON.stringify({type:'pass', payload:{roomId:myRoomId, playerId:myPlayerId}})); return; }
  executePass(myIdx);
}

function executePass(idx){
  if(!G)return;
  const p=G.players[idx];
  G.consecutivePasses++;
  addLog(`${p.name} passes`, 'system');

  // All-pass check: consecutivePasses reaches the number of players AND
  // the player passing right now is the last contributor (they chose to pass too).
  // This means every player including the last contributor has passed once.
  const n=G.players.length;
  if(G.consecutivePasses>=n && G.lastContributorIdx!==null){
    const contributorIdx=G.lastContributorIdx; // capture before reset
    const contributor=G.players[contributorIdx];
    addLog(`All players passed! Pile of ${G.pileCards.length} cards discarded. ${contributor.name} starts the new round.`,'system');
    toast(`Pile discarded — ${contributor.name} starts new round`,'gold');
    // Reset round
    G.pileCards=[];
    G.pile=[];
    G.lastPlay=null;
    G.roundRank=null;
    G.consecutivePasses=0;
    G.lastContributorIdx=null;
    G.currentPlayerIdx=contributorIdx;
    G.roundStarterIdx=contributorIdx;
    renderGame();
    setTimeout(()=>startTurn(),600);
    return;
  }

  // Advance turn
  G.currentPlayerIdx=(idx+1)%G.players.length;
  renderGame();
  startTurn();
}

function callCheck(){
  if(!G||!G.lastPlay||G.lastPlay.playerId===myPlayerId)return;
  const myIdx=G.players.findIndex(p=>p.id===myPlayerId);
  if(G.currentPlayerIdx!==myIdx)return;
  clearTurnTimer();
  if(ws && ws.readyState===1 && myRoomId){ ws.send(JSON.stringify({type:'check', payload:{roomId:myRoomId, playerId:myPlayerId}})); return; }
  resolveCheck(myPlayerId);
}


function endGame(winnerIdx){
  clearTurnTimer();
  G.winner=G.players[winnerIdx];
  addLog(`🏆 ${G.winner.name} wins the game!`,'winner');
  renderGame();
  showResultOverlay(G.winner);
}

function showResultOverlay(winner){
  // Create confetti
  const main=document.getElementById('gameMain');
  const overlay=document.createElement('div');
  overlay.className='result-overlay';
  overlay.id='resultOverlay';
  const isMe=winner.id===myPlayerId;
  overlay.innerHTML=`
    <div class="result-box">
      <div style="font-size:4rem;margin-bottom:12px">${isMe?'🏆':'🎯'}</div>
      <h2>${isMe?'You Win!':winner.name+' Wins!'}</h2>
      <div class="subtitle">${isMe?'Excellent bluffing skills!':'Better luck next time!'}</div>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="restartGame()">▶ Play Again</button>
        <button class="btn btn-secondary" onclick="showScreen('homeScreen')">← Home</button>
      </div>
    </div>`;
  // Confetti
  for(let i=0;i<50;i++){
    const el=document.createElement('div');
    el.className='confetti-item';
    el.style.cssText=`left:${Math.random()*100}%;top:-20px;width:${6+Math.random()*8}px;height:${6+Math.random()*8}px;background:${['#00e5c8','#f0b429','#ff4757','#2ed573','#a29bfe'][Math.floor(Math.random()*5)]};animation-delay:${Math.random()*2}s;animation-duration:${2+Math.random()*2}s`;
    overlay.appendChild(el);
  }
  main.appendChild(overlay);
}

function restartGame(){
  const overlay=document.getElementById('resultOverlay');
  if(overlay)overlay.remove();
  const players=G.players;
  initGame(players);
}

function confirmLeaveGame(){
  clearTurnTimer();
  if(G&&!G.winner&&confirm('Leave game? Progress will be lost.')){
    G=null;
    showScreen('homeScreen');
  }
}

// ============================================================
// BOT AI
// ============================================================
function botTakeTurn(idx){
  if(!G||G.winner||G.currentPlayerIdx!==idx)return;
  const p=G.players[idx];
  if(!p.isBot)return;
  const diff=p.diff||'medium';

  // ---- ROUND START: no pile yet, must play ----
  if(G.pileCards.length===0||G.roundRank===null){
    botPlayCards(p,diff,idx,true);
    return;
  }

  // ---- MID-ROUND: decide check / pass / play ----
  const canCheck=G.lastPlay&&G.lastPlay.playerId!==p.id;

  if(canCheck&&botDecideCheck(p,diff)){
    clearTurnTimer();
    addLog(`${p.name} calls CHECK on ${G.players[G.lastPlay.playerIdx].name}!`,'action');
    setTimeout(()=>resolveCheck(p.id),700);
    return;
  }

  // Decide: play cards or pass
  const requiredRank=G.roundRank;
  const matching=p.hand.filter(c=>c.rank===requiredRank);
  const shouldPlay=botDecidePlay(p,diff,matching);

  if(shouldPlay){
    botPlayCards(p,diff,idx,false);
  } else {
    clearTurnTimer();
    setTimeout(()=>executePass(idx),500);
  }
}

function botDecideCheck(bot,diff){
  if(!G.lastPlay)return false;
  const lp=G.lastPlay;
  // Count how many of this rank are accounted for (in bot's hand + already seen)
  const inHand=bot.hand.filter(c=>c.rank===lp.claimedRank).length;
  // Total claimed across the pile for this rank
  const totalClaimed=G.pile.filter(e=>e.claimedRank===lp.claimedRank).reduce((a,e)=>a+e.count,0);
  const impossible=totalClaimed+inHand>4;
  switch(diff){
    case 'easy':  return Math.random()<0.08;
    case 'medium':{
      if(impossible)return true;
      if(lp.count>=3&&Math.random()<0.35)return true;
      return Math.random()<0.12;
    }
    case 'hard':{
      if(impossible)return true;
      // How many of this rank could realistically still exist?
      const remaining=4-inHand-(totalClaimed-lp.count);
      if(remaining<lp.count&&Math.random()<0.8)return true;
      if(lp.count>=3&&Math.random()<0.5)return true;
      return Math.random()<0.07;
    }
    default: return false;
  }
}

function botDecidePlay(bot,diff,matching){
  // If no cards left, must pass
  if(bot.hand.length===0)return false;
  switch(diff){
    case 'easy':
      // Easy bots only play if they have the real card, else pass
      return matching.length>0;
    case 'medium':
      // Play 70% of the time regardless
      return Math.random()<0.70;
    case 'hard':
      // Play if it helps get rid of cards, or bluff strategically
      if(matching.length>0)return true; // always play honest cards
      // Bluff if hand is large
      return bot.hand.length>6?Math.random()<0.6:Math.random()<0.3;
    default: return matching.length>0;
  }
}

function botPlayCards(bot,diff,idx,isRoundStart){
  const requiredRank=isRoundStart?null:G.roundRank;
  let chosenRank, cardsToPlay;

  if(isRoundStart){
    // Choose a rank we have the most of
    const rankGroups={};
    bot.hand.forEach(c=>{rankGroups[c.rank]=rankGroups[c.rank]||[];rankGroups[c.rank].push(c);});
    const best=Object.values(rankGroups).sort((a,b)=>b.length-a.length)[0]||[bot.hand[0]];
    chosenRank=best[0].rank;
    const count=Math.min(best.length,1+Math.floor(Math.random()*(diff==='hard'?3:2)));
    cardsToPlay=best.slice(0,count);
  } else {
    chosenRank=requiredRank;
    const matching=bot.hand.filter(c=>c.rank===requiredRank);
    switch(diff){
      case 'easy':{
        cardsToPlay=matching.length>0?[matching[0]]:[bot.hand[0]];
        // Easy always claims the correct rank even if lying card-wise
        break;
      }
      case 'medium':{
        const shouldBluff=matching.length===0||(Math.random()<0.25&&bot.hand.length>7);
        if(!shouldBluff&&matching.length){
          cardsToPlay=matching.slice(0,Math.min(matching.length,1+Math.floor(Math.random()*2)));
        } else {
          const non=bot.hand.filter(c=>c.rank!==requiredRank);
          cardsToPlay=(non.length?non:bot.hand).slice(0,1+Math.floor(Math.random()*2));
        }
        break;
      }
      case 'hard':{
        if(matching.length>=2){
          cardsToPlay=matching.slice(0,Math.min(matching.length,2+Math.floor(Math.random()*2)));
        } else if(matching.length===1&&Math.random()<0.85){
          cardsToPlay=[matching[0]];
        } else {
          const rankGroups={};
          bot.hand.forEach(c=>{rankGroups[c.rank]=rankGroups[c.rank]||[];rankGroups[c.rank].push(c);});
          const best=Object.values(rankGroups).sort((a,b)=>b.length-a.length)[0]||bot.hand;
          cardsToPlay=best.slice(0,Math.min(best.length,1+Math.floor(Math.random()*2)));
        }
        break;
      }
      default: cardsToPlay=matching.length?[matching[0]]:[bot.hand[0]];
    }
  }
  if(!cardsToPlay||!cardsToPlay.length)cardsToPlay=[bot.hand[0]];
  clearTurnTimer();
  executePlay(idx,cardsToPlay,chosenRank);
}

// ============================================================
// TOAST
// ============================================================
function toast(msg,type='teal'){
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  el.textContent=msg;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),2500);
}

// ============================================================
// UTILS
// ============================================================
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Load settings from localStorage
try{
  const s=JSON.parse(localStorage.getItem('cardArenaSettings')||'{}');
  Object.assign(settings,s);
  document.getElementById('settingsName').value=settings.name;
  selectAvatar(settings.avatar||0);
  if(!settings.sound)document.getElementById('toggleSound').classList.remove('on');
  if(!settings.anim)document.getElementById('toggleAnim').classList.remove('on');
  if(settings.autoReady)document.getElementById('toggleAutoReady').classList.add('on');
}catch(e){}

// Save settings
const origSaveSettings=saveSettings;
window.saveSettings=function(){
  try{localStorage.setItem('cardArenaSettings',JSON.stringify(settings));}catch(e){}
  origSaveSettings();
};

// Ensure a random default player name on first load (user can change in settings)
if(!settings.name || settings.name==='Player'){
  const n = HUMAN_NAMES[Math.floor(Math.random()*HUMAN_NAMES.length)];
  settings.name = n + Math.floor(Math.random()*90+10);
  document.getElementById('settingsName').value = settings.name;
}
