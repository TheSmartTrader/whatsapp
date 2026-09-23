// ==========================================================
// TST Chat — live app logic (Firebase Auth + Firestore + WebRTC calling)
// ==========================================================
import { firebaseConfig } from './firebase-config.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, deleteUser, EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, onSnapshot, serverTimestamp,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// STUN servers only (free). For reliable calling across all networks
// (mobile data, strict NAT/firewalls) add a TURN server later — see README.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Kitni der tak koi user "online" mana jaaye agar unka last heartbeat na aaye
const ONLINE_WINDOW_MS = 35000;   // 35 seconds
const HEARTBEAT_EVERY_MS = 20000; // har 20 second apna lastSeen update karo
const ONLINE_REFRESH_MS = 10000;  // har 10 second online dots refresh karo (timer-based expiry ke liye)

let currentUser = null;     // { uid, name, email, photo }
let allUsers = [];          // other registered users
let myChats = [];           // chats current user belongs to
let activeChatId = null;
let unsubMessages = null;
let unsubChats = null;
let unsubUsers = null;

let heartbeatInterval = null;
let onlineRefreshInterval = null;

let pc = null;              // RTCPeerConnection
let localStream = null;
let currentCallId = null;
let unsubIncomingCalls = null;
let unsubCallDoc = null;
let unsubRemoteCandidates = null;
let muted = false;

/* ================= AUTH ================= */
function showLogin(){
  document.getElementById('login-form').style.display = 'block';
  document.getElementById('signup-form').style.display = 'none';
}
function showSignup(){
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('signup-form').style.display = 'block';
}

async function signup(){
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';
  if(!name || !email || password.length < 6){
    errEl.textContent = 'Naam, email, aur 6+ character password zaroori hai.';
    return;
  }
  try{
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid, name, email, photo: null,
      lastSeen: serverTimestamp(), createdAt: serverTimestamp()
    });
    // onAuthStateChanged will take it from here
  }catch(e){
    errEl.textContent = friendlyError(e);
  }
}

async function login(){
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try{
    await signInWithEmailAndPassword(auth, email, password);
  }catch(e){
    errEl.textContent = friendlyError(e);
  }
}

async function logout(){
  stopHeartbeat();
  cleanupCallListeners();
  if(unsubMessages) unsubMessages();
  if(unsubChats) unsubChats();
  if(unsubUsers) unsubUsers();
  await signOut(auth);
}

function friendlyError(e){
  const code = e.code || '';
  if(code.includes('email-already-in-use')) return 'Ye email pehle se registered hai. Login kar lo.';
  if(code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Email ya password galat hai.';
  if(code.includes('weak-password')) return 'Password kam az kam 6 characters ka ho.';
  if(code.includes('invalid-email')) return 'Email sahi format mein likho.';
  return 'Kuch masla hua: ' + (e.message || code);
}

onAuthStateChanged(auth, async (user)=>{
  if(user){
    const snap = await getDoc(doc(db, 'users', user.uid));
    const data = snap.exists() ? snap.data() : { name: user.email, email: user.email, photo: null };
    currentUser = { uid: user.uid, name: data.name, email: data.email, photo: data.photo || null };
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    listenUsers();
    listenMyChats();
    listenIncomingCalls();
    startHeartbeat();
  } else {
    currentUser = null;
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
});

/* ================= PRESENCE (online / offline) ================= */
function startHeartbeat(){
  beat();
  if(heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(beat, HEARTBEAT_EVERY_MS);

  if(onlineRefreshInterval) clearInterval(onlineRefreshInterval);
  onlineRefreshInterval = setInterval(()=>{
    renderChatList();
    if(document.getElementById('online-modal').classList.contains('show')) renderOnlineList();
  }, ONLINE_REFRESH_MS);
}
function stopHeartbeat(){
  if(heartbeatInterval){ clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if(onlineRefreshInterval){ clearInterval(onlineRefreshInterval); onlineRefreshInterval = null; }
}
function beat(){
  if(!currentUser) return;
  updateDoc(doc(db,'users',currentUser.uid), { lastSeen: serverTimestamp() }).catch(()=>{});
}
function isOnline(u){
  const t = u?.lastSeen?.toMillis ? u.lastSeen.toMillis() : 0;
  return !!t && (Date.now() - t) < ONLINE_WINDOW_MS;
}

/* ================= USERS (contacts) ================= */
function listenUsers(){
  if(unsubUsers) unsubUsers();
  unsubUsers = onSnapshot(collection(db, 'users'), (snap)=>{
    allUsers = snap.docs.map(d=>d.data()).filter(u=>u.uid !== currentUser.uid);
    renderChatList();
    if(activeChatId) renderChatHeader();
    if(document.getElementById('online-modal').classList.contains('show')) renderOnlineList();
  });
}
function getUser(uid){ return allUsers.find(u=>u.uid===uid); }
function initials(name){ return (name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase(); }

// Naam sirf initials ya photo dikhata hai — email kahin bhi doosre users ko nahi dikhta.
function avatarInner(name, photo){
  return photo ? `<img src="${photo}" alt="">` : initials(name);
}

/* ================= CHATS LIST ================= */
function listenMyChats(){
  const q = query(collection(db,'chats'), where('members','array-contains', currentUser.uid));
  if(unsubChats) unsubChats();
  unsubChats = onSnapshot(q, (snap)=>{
    myChats = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    myChats.sort((a,b)=> (b.lastMessageTime?.toMillis?.()||0) - (a.lastMessageTime?.toMillis?.()||0));
    renderChatList();
    if(activeChatId) renderChatHeader();
  });
}

function chatOtherUser(chat){
  if(chat.type==='group') return null;
  const otherUid = chat.members.find(m=>m!==currentUser.uid);
  return getUser(otherUid);
}
function chatDisplayName(chat){
  if(chat.type==='group') return chat.name;
  const u = chatOtherUser(chat);
  return u ? u.name : 'Unknown user';
}

function renderChatList(){
  const list = document.getElementById('chat-list');
  const q = (document.getElementById('search-input').value||'').toLowerCase();
  list.innerHTML = '';
  myChats
    .filter(c=> chatDisplayName(c).toLowerCase().includes(q))
    .forEach(chat=>{
      const other = chatOtherUser(chat);
      const name = chatDisplayName(chat);
      const row = document.createElement('div');
      row.className = 'chat-row' + (chat.id===activeChatId?' active':'');
      row.onclick = ()=> openChat(chat.id);
      const av = document.createElement('div');
      av.className = 'avatar' + (chat.type==='group'?' group':'');
      av.innerHTML = avatarInner(name, other?.photo) + (other && isOnline(other) ? '<span class="online-dot"></span>' : '');
      row.appendChild(av);
      const mid = document.createElement('div');
      mid.className = 'chat-row-mid';
      const time = chat.lastMessageTime?.toDate ? formatTime(chat.lastMessageTime.toDate()) : '';
      mid.innerHTML = `
        <div class="row-top">
          <div class="row-name">${escapeHtml(name)}</div>
          <div class="row-time">${time}</div>
        </div>
        <div class="row-bottom">
          <div class="row-preview">${escapeHtml(chat.lastMessage||'No messages yet')}</div>
        </div>`;
      row.appendChild(mid);
      list.appendChild(row);
    });
}

function escapeHtml(s){ const d=document.createElement('div'); d.textContent = s||''; return d.innerHTML; }
function formatTime(d){
  let h=d.getHours(), m=d.getMinutes();
  const ampm = h>=12?'PM':'AM'; h=h%12; if(h===0)h=12;
  return `${h}:${m.toString().padStart(2,'0')} ${ampm}`;
}

/* ================= CHAT VIEW / MESSAGES ================= */
function openChat(chatId){
  activeChatId = chatId;
  document.body.classList.add('chat-open');
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('active-chat').style.display = 'flex';
  renderChatHeader();

  if(unsubMessages) unsubMessages();
  const q = query(collection(db,'chats',chatId,'messages'), orderBy('createdAt','asc'));
  unsubMessages = onSnapshot(q, (snap)=>{
    const messages = snap.docs.map(d=>({ id:d.id, ...d.data(), pending: d.metadata.hasPendingWrites }));
    renderMessages(messages);
    markMessagesSeen(chatId, snap.docs);
  });

  renderChatList();
  document.getElementById('msg-input').focus();
}
function closeChat(){ document.body.classList.remove('chat-open'); }

function renderChatHeader(){
  const chat = myChats.find(c=>c.id===activeChatId);
  if(!chat) return;
  const other = chatOtherUser(chat);
  const name = chatDisplayName(chat);
  const avEl = document.getElementById('ch-avatar');
  avEl.className = 'avatar' + (chat.type==='group'?' group':'');
  avEl.innerHTML = avatarInner(name, other?.photo);
  document.getElementById('ch-name').textContent = name;
  if(chat.type==='group'){
    const names = chat.members.filter(m=>m!==currentUser.uid).map(uid=>getUser(uid)?.name?.split(' ')[0]||'?').join(', ');
    document.getElementById('ch-status').textContent = names;
  } else {
    document.getElementById('ch-status').innerHTML = (other && isOnline(other)) ? '<span style="color:var(--green);">online</span>' : '';
  }
}

// Sirf mere bheje hue messages ke liye tick icon (single = local se send hua,
// double grey = server tak pohanch gaya, double blue = doosre ne dekh liya)
function tickSvg(pending, seen){
  const color = seen ? 'var(--tick-blue)' : 'var(--tick-grey)';
  if(pending){
    return `<span class="ticks"><svg width="14" height="11" viewBox="0 0 16 11" fill="none"><path d="M1 5.5L5 9.5L11 1.5" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }
  return `<span class="ticks"><svg width="16" height="11" viewBox="0 0 16 11" fill="none"><path d="M1 5.5L5 9.5L11 1.5" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 5.5L9.5 9.5L15.5 1.5" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}

function renderMessages(messages){
  const chat = myChats.find(c=>c.id===activeChatId);
  const wrap = document.getElementById('messages');
  wrap.innerHTML = '';
  let lastDay = null;
  messages.forEach(m=>{
    const created = m.createdAt?.toDate ? m.createdAt.toDate() : new Date();
    const dayStr = created.toDateString();
    if(dayStr !== lastDay){
      const chip = document.createElement('div');
      chip.className='day-chip';
      chip.textContent = dayStr === new Date().toDateString() ? 'Today' : created.toLocaleDateString();
      wrap.appendChild(chip);
      lastDay = dayStr;
    }
    const mine = m.senderId === currentUser.uid;
    const row = document.createElement('div');
    row.className = 'bubble-row ' + (mine?'out':'in');
    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + (mine?'out':'in');
    let senderHtml = '';
    if(chat?.type==='group' && !mine){
      senderHtml = `<span class="sender" style="color:${colorForSender(m.senderName||'')}">${escapeHtml(m.senderName)}</span>`;
    }
    const ticksHtml = mine ? tickSvg(!!m.pending, m.status==='seen') : '';
    bubble.innerHTML = `${senderHtml}<span class="msg-text">${escapeHtml(m.text)}</span><span class="meta">${formatTime(created)}${ticksHtml}</span>`;
    row.appendChild(bubble);
    wrap.appendChild(row);
  });
  wrap.scrollTop = wrap.scrollHeight;
}
function colorForSender(name){
  const colors=['#E17055','#0984E3','#00B894','#6C5CE7','#D63031','#00CEC9'];
  let h=0; for(let i=0;i<name.length;i++) h=name.charCodeAt(i)+((h<<5)-h);
  return colors[Math.abs(h)%colors.length];
}

// Jo bhi messages mere pass abhi khuli hui chat mein dikhe aur mere nahi bheje
// hue hain, unko "seen" mark kar do — jisse bhejne wale ko blue double-tick dikhega.
function markMessagesSeen(chatId, docs){
  docs.forEach(d=>{
    const data = d.data();
    if(data.senderId !== currentUser.uid && data.status !== 'seen'){
      updateDoc(doc(db,'chats',chatId,'messages',d.id), { status:'seen' }).catch(()=>{});
    }
  });
}

async function sendMessage(){
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if(!text || !activeChatId) return;
  input.value = '';
  await addDoc(collection(db,'chats',activeChatId,'messages'), {
    senderId: currentUser.uid, senderName: currentUser.name, text, status:'sent', createdAt: serverTimestamp()
  });
  await updateDoc(doc(db,'chats',activeChatId), {
    lastMessage: text, lastMessageTime: serverTimestamp()
  });
}

/* ================= NEW CHAT / GROUP ================= */
function closeModals(){
  document.querySelectorAll('.modal-backdrop.show').forEach(m=>m.classList.remove('show'));
}
function openNewChatModal(){
  const box = document.getElementById('new-chat-contacts');
  box.innerHTML = '';
  if(allUsers.length===0){
    box.innerHTML = '<div style="padding:16px 18px;color:#667781;font-size:13.5px;">Abhi koi aur registered user nahi hai. Kisi aur ko sign up karwao.</div>';
  }
  allUsers.forEach(u=>{
    const row = document.createElement('div');
    row.className='contact-pick';
    row.innerHTML = `<div class="avatar" style="width:40px;height:40px;font-size:14px;">${avatarInner(u.name,u.photo)}${isOnline(u)?'<span class="online-dot"></span>':''}</div>
      <div><div style="font-weight:600;font-size:14.5px;">${escapeHtml(u.name)}</div></div>`;
    row.onclick = async ()=>{
      closeModals();
      const chatId = [currentUser.uid, u.uid].sort().join('_');
      const existing = myChats.find(c=>c.id===chatId);
      if(existing){ openChat(chatId); return; }
      await setDoc(doc(db,'chats',chatId), {
        type:'dm', members:[currentUser.uid, u.uid],
        lastMessage:'', lastMessageTime: serverTimestamp(), createdAt: serverTimestamp()
      });
      openChat(chatId);
    };
    box.appendChild(row);
  });
  document.getElementById('new-chat-modal').classList.add('show');
}

let groupSelection = new Set();
function openNewGroupModal(){
  groupSelection = new Set();
  document.getElementById('group-name-input').value = '';
  const box = document.getElementById('new-group-contacts');
  box.innerHTML = '';
  allUsers.forEach(u=>{
    const row = document.createElement('div');
    row.className='contact-pick';
    row.innerHTML = `<input type="checkbox" id="grp-${u.uid}">
      <div class="avatar" style="width:40px;height:40px;font-size:14px;">${avatarInner(u.name,u.photo)}</div>
      <div style="font-weight:600;font-size:14.5px;">${escapeHtml(u.name)}</div>`;
    row.querySelector('input').onchange = (e)=>{
      if(e.target.checked) groupSelection.add(u.uid); else groupSelection.delete(u.uid);
      validateGroupForm();
    };
    row.onclick = (e)=>{
      if(e.target.tagName!=='INPUT'){
        const cb = row.querySelector('input'); cb.checked=!cb.checked; cb.dispatchEvent(new Event('change'));
      }
    };
    box.appendChild(row);
  });
  validateGroupForm();
  document.getElementById('new-group-modal').classList.add('show');
}
function validateGroupForm(){
  const name = document.getElementById('group-name-input').value.trim();
  document.getElementById('create-group-btn').disabled = !(name && groupSelection.size>=1);
}
async function createGroup(){
  const name = document.getElementById('group-name-input').value.trim();
  const members = Array.from(groupSelection);
  members.push(currentUser.uid);
  if(!name || members.length<2) return;
  const ref = await addDoc(collection(db,'chats'), {
    type:'group', name, members,
    lastMessage:`Group created by ${currentUser.name}`, lastMessageTime: serverTimestamp(), createdAt: serverTimestamp()
  });
  closeModals();
  openChat(ref.id);
}

/* ================= ONLINE NOW MODAL ================= */
function openOnlineModal(){
  renderOnlineList();
  document.getElementById('online-modal').classList.add('show');
}
function renderOnlineList(){
  const box = document.getElementById('online-list-body');
  const onlineUsers = allUsers.filter(isOnline);
  box.innerHTML = '';
  if(onlineUsers.length===0){
    box.innerHTML = '<div style="padding:16px 18px;color:#667781;font-size:13.5px;">Abhi koi online nahi hai.</div>';
    return;
  }
  onlineUsers.forEach(u=>{
    const row = document.createElement('div');
    row.className = 'contact-pick';
    row.style.cursor = 'default';
    row.innerHTML = `<div class="avatar" style="width:40px;height:40px;font-size:14px;">${avatarInner(u.name,u.photo)}<span class="online-dot"></span></div>
      <div style="font-weight:600;font-size:14.5px;">${escapeHtml(u.name)}</div>`;
    box.appendChild(row);
  });
}

/* ================= PROFILE PHOTO ================= */
function openProfileModal(){
  document.getElementById('profile-avatar-preview').innerHTML = avatarInner(currentUser.name, currentUser.photo);
  document.getElementById('profile-name-display').textContent = currentUser.name;
  document.getElementById('profile-modal').classList.add('show');
}

// Chuni hui photo ko chhote square (200x200) crop + compress karta hai taake
// Firestore document ke andar aasani se fit ho jaaye, phir turant save karta hai.
function resizeImageToDataUrl(file, size){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onerror = ()=> reject(new Error('File padhi nahi ja saki.'));
    reader.onload = ()=>{
      const img = new Image();
      img.onerror = ()=> reject(new Error('Ye image kholi nahi ja saki.'));
      img.onload = ()=>{
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const s = Math.min(img.width, img.height);
        const sx = (img.width - s)/2, sy = (img.height - s)/2;
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function onProfilePhotoSelected(e){
  const file = e.target.files[0];
  if(!file) return;
  try{
    const dataUrl = await resizeImageToDataUrl(file, 200);
    await updateDoc(doc(db,'users',currentUser.uid), { photo: dataUrl });
    currentUser.photo = dataUrl;
    document.getElementById('profile-avatar-preview').innerHTML = avatarInner(currentUser.name, dataUrl);
    renderChatList();
    if(activeChatId) renderChatHeader();
  }catch(err){
    alert('Photo save nahi ho saki: ' + (err.message || err));
  }
  e.target.value = '';
}

/* ================= DELETE ACCOUNT ================= */
function openDeleteAccountModal(){
  document.getElementById('delete-reason').value = '';
  document.getElementById('delete-password').value = '';
  document.getElementById('delete-account-error').textContent = '';
  validateDeleteForm();
  document.getElementById('delete-account-modal').classList.add('show');
}
function validateDeleteForm(){
  const reason = document.getElementById('delete-reason').value.trim();
  const password = document.getElementById('delete-password').value;
  const btn = document.getElementById('confirm-delete-btn');
  if(btn) btn.disabled = !(reason.length >= 5 && password.length >= 1);
}

async function confirmDeleteAccount(){
  const reason = document.getElementById('delete-reason').value.trim();
  const password = document.getElementById('delete-password').value;
  const errEl = document.getElementById('delete-account-error');
  const btn = document.getElementById('confirm-delete-btn');
  errEl.textContent = '';

  if(reason.length < 5){
    errEl.textContent = 'Please bataiye account delete karne ki wajah (kam az kam kuch words).';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Deleting…';

  try{
    // Security ke liye password se dobara verify (Firebase sensitive actions ke
    // liye "recent login" maangta hai).
    const cred = EmailAuthProvider.credential(currentUser.email, password);
    await reauthenticateWithCredential(auth.currentUser, cred);

    // Delete karne se pehle reason ko save kar lo (khud user ke record ke tor par).
    await addDoc(collection(db, 'account_deletions'), {
      uid: currentUser.uid,
      name: currentUser.name,
      email: currentUser.email,
      reason,
      deletedAt: serverTimestamp()
    });

    stopHeartbeat();
    cleanupCallListeners();
    if(unsubMessages) unsubMessages();
    if(unsubChats) unsubChats();
    if(unsubUsers) unsubUsers();

    await deleteDoc(doc(db, 'users', currentUser.uid));
    await deleteUser(auth.currentUser);

    closeModals();
    // onAuthStateChanged khud auth-screen dikha dega kyunke user ab exist nahi karta.
  }catch(e){
    const code = e.code || '';
    if(code.includes('wrong-password') || code.includes('invalid-credential')){
      errEl.textContent = 'Password galat hai.';
    } else if(code.includes('requires-recent-login')){
      errEl.textContent = 'Security ke liye pehle logout karke dobara login karein, phir delete try karein.';
    } else {
      errEl.textContent = 'Kuch masla hua: ' + (e.message || code);
    }
    btn.disabled = false;
    btn.textContent = 'Delete my account';
  }
}

/* ================= VOICE CALLING (WebRTC + Firestore signaling) ================= */
function getOtherUidForActiveChat(){
  const chat = myChats.find(c=>c.id===activeChatId);
  if(!chat || chat.type!=='dm') return null;
  return chat.members.find(m=>m!==currentUser.uid);
}

async function startCall(){
  const calleeUid = getOtherUidForActiveChat();
  if(!calleeUid){ alert('Voice call abhi sirf 1-to-1 chat mein available hai.'); return; }
  const calleeUser = getUser(calleeUid);

  pc = new RTCPeerConnection(RTC_CONFIG);
  localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));

  const remoteAudio = document.getElementById('remote-audio');
  const remoteStream = new MediaStream();
  remoteAudio.srcObject = remoteStream;
  pc.ontrack = (e)=> e.streams[0].getTracks().forEach(t=>remoteStream.addTrack(t));

  const callDocRef = doc(collection(db,'calls'));
  currentCallId = callDocRef.id;
  const callerCandidates = collection(callDocRef, 'callerCandidates');
  const calleeCandidates = collection(callDocRef, 'calleeCandidates');

  pc.onicecandidate = (e)=>{ if(e.candidate) addDoc(callerCandidates, e.candidate.toJSON()); };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await setDoc(callDocRef, {
    callerId: currentUser.uid, callerName: currentUser.name,
    calleeId: calleeUid, calleeName: calleeUser?.name || '',
    offer: { type: offer.type, sdp: offer.sdp },
    status: 'ringing', createdAt: serverTimestamp()
  });

  showCallOverlay(calleeUser?.name || 'Unknown', true, calleeUser?.photo);

  unsubCallDoc = onSnapshot(callDocRef, async (snap)=>{
    const data = snap.data();
    if(!data) return;
    if(data.status==='accepted' && data.answer && pc.currentRemoteDescription===null){
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      document.getElementById('call-status').textContent = '00:00';
      document.getElementById('call-status').classList.remove('ringing');
      startCallTimer();
    }
    if(data.status==='declined' || data.status==='ended'){
      teardownCall(false);
    }
  });
  unsubRemoteCandidates = onSnapshot(calleeCandidates, (snap)=>{
    snap.docChanges().forEach(change=>{
      if(change.type==='added') pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
    });
  });
}

function listenIncomingCalls(){
  const q = query(collection(db,'calls'), where('calleeId','==', currentUser.uid), where('status','==','ringing'));
  if(unsubIncomingCalls) unsubIncomingCalls();
  unsubIncomingCalls = onSnapshot(q, (snap)=>{
    snap.docChanges().forEach(change=>{
      if(change.type==='added'){
        const data = change.doc.data();
        showIncomingBanner(change.doc.id, data.callerName, getUser(data.callerId)?.photo);
      }
    });
  });
}

let pendingIncomingCallId = null;
function showIncomingBanner(callId, callerName, callerPhoto){
  pendingIncomingCallId = callId;
  document.getElementById('incoming-avatar').innerHTML = avatarInner(callerName, callerPhoto);
  document.getElementById('incoming-name').textContent = callerName;
  document.getElementById('incoming-call').classList.add('show');
}
function hideIncomingBanner(){
  document.getElementById('incoming-call').classList.remove('show');
}

async function acceptCall(){
  const callId = pendingIncomingCallId;
  hideIncomingBanner();
  if(!callId) return;
  currentCallId = callId;
  const callDocRef = doc(db,'calls',callId);
  const snap = await getDoc(callDocRef);
  const data = snap.data();
  if(!data) return;

  pc = new RTCPeerConnection(RTC_CONFIG);
  localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));

  const remoteAudio = document.getElementById('remote-audio');
  const remoteStream = new MediaStream();
  remoteAudio.srcObject = remoteStream;
  pc.ontrack = (e)=> e.streams[0].getTracks().forEach(t=>remoteStream.addTrack(t));

  const callerCandidates = collection(callDocRef, 'callerCandidates');
  const calleeCandidates = collection(callDocRef, 'calleeCandidates');
  pc.onicecandidate = (e)=>{ if(e.candidate) addDoc(calleeCandidates, e.candidate.toJSON()); };

  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  await updateDoc(callDocRef, {
    answer: { type: answer.type, sdp: answer.sdp }, status:'accepted'
  });

  showCallOverlay(data.callerName, false, getUser(data.callerId)?.photo);
  document.getElementById('call-status').textContent = '00:00';
  document.getElementById('call-status').classList.remove('ringing');
  startCallTimer();

  unsubRemoteCandidates = onSnapshot(callerCandidates, (snap)=>{
    snap.docChanges().forEach(change=>{
      if(change.type==='added') pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
    });
  });
  unsubCallDoc = onSnapshot(callDocRef, (snap)=>{
    const d = snap.data();
    if(d && (d.status==='ended')) teardownCall(false);
  });
}

async function declineCall(){
  const callId = pendingIncomingCallId;
  hideIncomingBanner();
  if(!callId) return;
  await updateDoc(doc(db,'calls',callId), { status:'declined' });
  pendingIncomingCallId = null;
}

function showCallOverlay(name, isCaller, photo){
  document.getElementById('call-avatar').innerHTML = avatarInner(name, photo);
  document.getElementById('call-name').textContent = name;
  document.getElementById('call-status').textContent = isCaller ? 'Calling…' : 'Connecting…';
  document.getElementById('call-status').classList.add('ringing');
  muted = false;
  document.getElementById('mute-btn').classList.remove('active');
  document.getElementById('call-overlay').classList.add('show');
}

let callTimerInterval = null, callSeconds = 0;
function startCallTimer(){
  callSeconds = 0;
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(()=>{
    callSeconds++;
    const m=Math.floor(callSeconds/60).toString().padStart(2,'0');
    const s=(callSeconds%60).toString().padStart(2,'0');
    document.getElementById('call-status').textContent = `${m}:${s}`;
  },1000);
}

function toggleMute(){
  muted = !muted;
  if(localStream) localStream.getAudioTracks().forEach(t=> t.enabled = !muted);
  document.getElementById('mute-btn').classList.toggle('active', muted);
}

async function endCall(){
  if(currentCallId){
    try{ await updateDoc(doc(db,'calls',currentCallId), { status:'ended' }); }catch(e){}
  }
  teardownCall(true);
}

function teardownCall(logMessage){
  document.getElementById('call-overlay').classList.remove('show');
  clearInterval(callTimerInterval);
  if(pc){ pc.close(); pc = null; }
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream = null; }
  if(unsubCallDoc){ unsubCallDoc(); unsubCallDoc = null; }
  if(unsubRemoteCandidates){ unsubRemoteCandidates(); unsubRemoteCandidates = null; }

  if(logMessage && activeChatId && callSeconds >= 0){
    const chat = myChats.find(c=>c.id===activeChatId);
    if(chat){
      const m=Math.floor(callSeconds/60).toString().padStart(2,'0');
      const s=(callSeconds%60).toString().padStart(2,'0');
      const text = callSeconds>0 ? `📞 Voice call · ${m}:${s}` : `📞 Call ended`;
      addDoc(collection(db,'chats',activeChatId,'messages'), {
        senderId: currentUser.uid, senderName: currentUser.name, text, status:'sent', createdAt: serverTimestamp()
      });
      updateDoc(doc(db,'chats',activeChatId), { lastMessage:text, lastMessageTime: serverTimestamp() });
    }
  }
  currentCallId = null;
  callSeconds = 0;
}

function cleanupCallListeners(){
  if(unsubIncomingCalls){ unsubIncomingCalls(); unsubIncomingCalls = null; }
  teardownCall(false);
}

/* ================= EXPOSE TO WINDOW (called from index.html inline handlers) ================= */
window.TST = {
  showLogin, showSignup, signup, login, logout,
  renderChatList, openChat, closeChat, sendMessage,
  openNewChatModal, openNewGroupModal, closeModals, validateGroupForm, createGroup,
  openOnlineModal, openProfileModal, onProfilePhotoSelected,
  openDeleteAccountModal, validateDeleteForm, confirmDeleteAccount,
  startCall, acceptCall, declineCall, toggleMute, endCall
};
