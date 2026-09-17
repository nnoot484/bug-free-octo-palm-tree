// In-Memory State Container (Zero Persistence)
let session = {
    hsUrl: '',
    accessToken: '',
    userId: '',
    activeRoomId: null,
    nextBatch: null,
    syncAbortController: null
  };
  
  // UI Element Bindings
  const loginView = document.getElementById('login-view');
  const chatView = document.getElementById('chat-view');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const roomListEl = document.getElementById('room-list');
  const messageListEl = document.getElementById('message-list');
  const messageForm = document.getElementById('message-form');
  const messageInput = document.getElementById('message-input');
  const currentChatTitle = document.getElementById('current-chat-title');
  const backToRoomsBtn = document.getElementById('back-to-rooms');
  const logoutBtn = document.getElementById('logout-btn');
  const closeOverlayBtn = document.getElementById('close-overlay-btn');
  
  // Close Overlay completely deletes the iframe
  closeOverlayBtn.addEventListener('click', () => {
    cleanupSession();
    const container = window.parent.document.getElementById('matrix-overlay-container');
    if (container) container.remove();
  });
  
  // Login Handler
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    
    let hs = document.getElementById('hs-url').value.trim().replace(/\/+$/, '');
    let username = document.getElementById('username').value.trim();
    let password = document.getElementById('password').value;
    let tokenInput = document.getElementById('access-token').value.trim();
  
    session.hsUrl = hs;
  
    try {
      if (tokenInput) {
        session.accessToken = tokenInput;
        // Resolve user id from token profile check
        const res = await fetch(`${hs}/_matrix/client/v3/account/whoami`, {
          headers: { 'Authorization': `Bearer ${session.accessToken}` }
        });
        if (!res.ok) throw new Error('Invalid Access Token');
        const data = await res.json();
        session.userId = data.user_id;
      } else {
        // Password login flow
        const res = await fetch(`${hs}/_matrix/client/v3/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: username },
            password: password
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');
        session.accessToken = data.access_token;
        session.userId = data.user_id;
      }
  
      // Switch views and initialize app loop
      loginView.classList.remove('active');
      chatView.classList.add('active');
      loadRooms();
      startSyncLoop();
    } catch (err) {
      loginError.textContent = err.message;
    }
  });
  
  // Fetch and Render Rooms
  async function loadRooms() {
    try {
      const res = await fetch(`${session.hsUrl}/_matrix/client/v3/joined_rooms`, {
        headers: { 'Authorization': `Bearer ${session.accessToken}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error('Failed to load rooms');
  
      roomListEl.innerHTML = '';
      for (const roomId of data.joined_rooms) {
        // Fetch basic room name state
        const nameRes = await fetch(`${session.hsUrl}/_matrix/client/v3/rooms/${roomId}/state/m.room.name/`, {
          headers: { 'Authorization': `Bearer ${session.accessToken}` }
        });
        let roomName = roomId;
        if (nameRes.ok) {
          const nameData = await nameRes.json();
          if (nameData.name) roomName = nameData.name;
        }
  
        const div = document.createElement('div');
        div.className = 'room-item';
        div.innerHTML = `<span class="room-name">${escapeHtml(roomName)}</span>`;
        div.onclick = () => openRoom(roomId, roomName);
        roomListEl.appendChild(div);
      }
    } catch (err) {
      roomListEl.innerHTML = `<div class="error" style="padding:15px;">Error loading rooms: ${err.message}</div>`;
    }
  }
  
  // Open Specific Room View
  async function openRoom(roomId, roomName) {
    session.activeRoomId = roomId;
    currentChatTitle.textContent = roomName;
    roomListEl.classList.remove('active');
    document.getElementById('message-pane').classList.add('active');
    backToRoomsBtn.classList.remove('hidden');
  
    messageListEl.innerHTML = '<div class="loading-state">Loading messages...</div>';
  
    try {
      const res = await fetch(`${session.hsUrl}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=30`, {
        headers: { 'Authorization': `Bearer ${session.accessToken}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error('Failed to fetch messages');
  
      messageListEl.innerHTML = '';
      // Matrix messages arrive newest-first with dir=b, reverse to chronological
      const msgs = data.chunk.reverse();
      for (const msg of msgs) {
        appendMessageToDOM(msg);
      }
      scrollToBottom();
    } catch (err) {
      messageListEl.innerHTML = `<div class="error">Failed to load history</div>`;
    }
  }
  
  // Back button handler
  backToRoomsBtn.addEventListener('click', () => {
    session.activeRoomId = null;
    currentChatTitle.textContent = "Rooms";
    document.getElementById('message-pane').classList.remove('active');
    roomListEl.classList.add('active');
    backToRoomsBtn.classList.add('hidden');
  });
  
  // Send Message
  messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !session.activeRoomId) return;
  
    messageInput.value = '';
    const txnId = 'm' + Date.now();
  
    try {
      const res = await fetch(`${session.hsUrl}/_matrix/client/v3/rooms/${session.activeRoomId}/send/m.room.message/${txnId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          msgtype: 'm.text',
          body: text
        })
      });
      if (!res.ok) throw new Error('Send failed');
    } catch (err) {
      alert('Failed to send message');
    }
  });
  
  // Long-polling Sync Loop
  async function startSyncLoop() {
    session.syncAbortController = new AbortController();
  
    try {
      while (true) {
        let url = `${session.hsUrl}/_matrix/client/v3/sync?timeout=30000`;
        if (session.nextBatch) url += `&since=${session.nextBatch}`;
  
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${session.accessToken}` },
          signal: session.syncAbortController.signal
        });
  
        if (!res.ok) {
          if (res.status === 401) { logout(); break; }
          await new Promise(r => setTimeout(r, 5000)); // Backoff on error
          continue;
        }
  
        const data = await res.json();
        session.nextBatch = data.next_batch;
  
        // Handle live messages in active room
        if (data.rooms && data.rooms.join && session.activeRoomId) {
          const roomData = data.rooms.join[session.activeRoomId];
          if (roomData && roomData.timeline && roomData.timeline.events) {
            for (const ev of roomData.timeline.events) {
              if (ev.type === 'm.room.message') {
                appendMessageToDOM(ev);
                scrollToBottom();
              }
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Sync loop error:', err);
      }
    }
  }
  
  // Helper to append message structure to UI
  function appendMessageToDOM(event) {
    if (!event.content || event.content.msgtype !== 'm.text') return;
    const isOutgoing = event.sender === session.userId;
    const div = document.createElement('div');
    div.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    
    if (!isOutgoing) {
      const senderEl = document.createElement('div');
      senderEl.className = 'message-sender';
      senderEl.textContent = event.sender;
      div.appendChild(senderEl);
    }
    
    const textEl = document.createElement('div');
    textEl.textContent = event.content.body;
    div.appendChild(textEl);
    
    messageListEl.appendChild(div);
  }
  
  function scrollToBottom() {
    messageListEl.scrollTop = messageListEl.scrollHeight;
  }
  
  // Logout & Server Invalidation
  logoutBtn.addEventListener('click', logout);
  
  async function logout() {
    try {
      if (session.accessToken) {
        await fetch(`${session.hsUrl}/_matrix/client/v3/logout`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.accessToken}` }
        });
      }
    } catch (e) {
      // Ignore network dropouts during logout request
    }
    cleanupSession();
    chatView.classList.remove('active');
    loginView.classList.add('active');
  }
  
  function cleanupSession() {
    if (session.syncAbortController) {
      session.syncAbortController.abort();
    }
    session = {
      hsUrl: '',
      accessToken: '',
      userId: '',
      activeRoomId: null,
      nextBatch: null,
      syncAbortController: null
    };
  }
  
  function escapeHtml(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag] || tag)
    );
  }