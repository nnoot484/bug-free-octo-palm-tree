// In-memory state only (Zero persistence)
let sessionState = {
    hsUrl: '',
    accessToken: '',
    userId: '',
    nextBatch: null
  };
  
  let activeRoomId = null;
  let syncInterval = null;
  
  const $ = id => document.getElementById(id);
  
  // Close overlay logic
  function closeOverlay() {
    stopSync();
    // Clear RAM state explicitly
    sessionState = { hsUrl: '', accessToken: '', userId: '', nextBatch: null };
    activeRoomId = null;
    
    if (window.parent && window.parent !== window) {
      const overlay = window.parent.document.getElementById('matrix-overlay-root');
      if (overlay) overlay.remove();
    }
  }
  
  $('close-overlay-btn').addEventListener('click', closeOverlay);
  
  // Login Submission
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hsUrlInput = $('hs-url').value.trim().replace(/\/+$/, '');
    const username = $('username').value.trim();
    const password = $('password').value;
    const directToken = $('access-token').value.trim();
  
    sessionState.hsUrl = hsUrlInput;
  
    try {
      if (directToken) {
        sessionState.accessToken = directToken;
        // Resolve user id from token via /_matrix/client/v3/account/whoami
        const res = await fetch(`${hsUrlInput}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${directToken}` }
        });
        if (!res.ok) throw new Error('Invalid Access Token');
        const data = await res.json();
        sessionState.userId = data.user_id;
      } else {
        // Standard password login
        const res = await fetch(`${hsUrlInput}/_matrix/client/v3/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: username },
            password: password
          })
        });
        if (!res.ok) throw new Error('Login failed. Check credentials.');
        const data = await res.json();
        sessionState.accessToken = data.access_token;
        sessionState.userId = data.user_id;
      }
  
      // Switch Screens
      $('login-screen').classList.remove('active');
      $('chat-screen').classList.add('active');
      
      await initChat();
    } catch (err) {
      alert(err.message);
    }
  });
  
  // Logout Button
  $('logout-btn').addEventListener('click', async () => {
    try {
      await fetch(`${sessionState.hsUrl}/_matrix/client/v3/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionState.accessToken}` }
      });
    } catch (e) {
      console.warn('Server-side logout failed:', e);
    }
    stopSync();
    $('chat-screen').classList.remove('active');
    $('login-screen').classList.add('active');
    // Wipe inputs
    $('password').value = '';
    $('access-token').value = '';
  });
  
  // Load Rooms & Start Sync Loop
  async function initChat() {
    await loadRooms();
    startSyncLoop();
  }
  
  async function loadRooms() {
    const roomListEl = $('room-list');
    roomListEl.innerHTML = '<div class="loading">Loading rooms...</div>';
  
    try {
      const res = await fetch(`${sessionState.hsUrl}/_matrix/client/v3/joined_rooms`, {
        headers: { Authorization: `Bearer ${sessionState.accessToken}` }
      });
      const data = await res.json();
      
      roomListEl.innerHTML = '';
      if (!data.joined_rooms || data.joined_rooms.length === 0) {
        roomListEl.innerHTML = '<div class="loading">No joined rooms found.</div>';
        return;
      }
  
      for (const roomId of data.joined_rooms) {
        // Fetch room name from state
        let roomName = roomId;
        try {
          const nameRes = await fetch(`${sessionState.hsUrl}/_matrix/client/v3/rooms/${roomId}/state/m.room.name/`, {
            headers: { Authorization: `Bearer ${sessionState.accessToken}` }
          });
          if (nameRes.ok) {
            const nameData = await nameRes.json();
            if (nameData.name) roomName = nameData.name;
          }
        } catch (e) {}
  
        const item = document.createElement('div');
        item.className = 'room-item';
        item.textContent = roomName;
        item.dataset.roomId = roomId;
        item.addEventListener('click', () => selectRoom(roomId, roomName));
        roomListEl.appendChild(item);
      }
    } catch (err) {
      roomListEl.innerHTML = '<div class="loading">Failed to load rooms.</div>';
    }
  }
  
  async function selectRoom(roomId, roomName) {
    activeRoomId = roomId;
    document.querySelectorAll('.room-item').forEach(el => {
      el.classList.toggle('active', el.dataset.roomId === roomId);
    });
    $('current-room-name').textContent = roomName;
    await loadRoomMessages(roomId);
  }
  
  async function loadRoomMessages(roomId) {
    const container = $('message-container');
    container.innerHTML = '<div class="loading">Loading messages...</div>';
  
    try {
      const res = await fetch(`${sessionState.hsUrl}/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=30`, {
        headers: { Authorization: `Bearer ${sessionState.accessToken}` }
      });
      const data = await res.json();
      container.innerHTML = '';
      
      // Reverse chunk to show chronological layout
      const chunks = (data.chunk || []).reverse();
      for (const event of chunks) {
        appendMessageEvent(event);
      }
      scrollToBottom();
    } catch (err) {
      container.innerHTML = '<div class="loading">Failed to load messages.</div>';
    }
  }
  
  function appendMessageEvent(event) {
    if (event.type !== 'm.room.message' || !event.content || !event.content.body) return;
    const container = $('message-container');
    
    const div = document.createElement('div');
    const isOutgoing = event.sender === sessionState.userId;
    div.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
  
    const senderSpan = document.createElement('span');
    senderSpan.className = 'sender';
    senderSpan.textContent = event.sender;
    div.appendChild(senderSpan);
  
    const textNode = document.createTextNode(event.content.body);
    div.appendChild(textNode);
  
    container.appendChild(div);
  }
  
  function scrollToBottom() {
    const container = $('message-container');
    container.scrollTop = container.scrollHeight;
  }
  
  // Send Message Handler
  $('send-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeRoomId) return;
    const input = $('message-input');
    const text = input.value.trim();
    if (!text) return;
  
    input.value = '';
    const txnId = 'm' + Date.now();
  
    try {
      const res = await fetch(`${sessionState.hsUrl}/_matrix/client/v3/rooms/${activeRoomId}/send/m.room.message/${txnId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionState.accessToken}`
        },
        body: JSON.stringify({
          msgtype: 'm.text',
          body: text
        })
      });
      if (!res.ok) throw new Error('Failed to send');
    } catch (err) {
      alert('Could not send message.');
    }
  });
  
  // Long-polling Sync Loop
  function startSyncLoop() {
    if (syncInterval) return;
    
    const poll = async () => {
      if (!sessionState.accessToken) return;
      try {
        let url = `${sessionState.hsUrl}/_matrix/client/v3/sync?timeout=30000`;
        if (sessionState.nextBatch) {
          url += `&since=${sessionState.nextBatch}`;
        }
  
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${sessionState.accessToken}` }
        });
        
        if (res.ok) {
          const data = await res.json();
          sessionState.nextBatch = data.next_batch;
  
          // Check if new events arrived for the active room
          if (activeRoomId && data.rooms && data.rooms.join && data.rooms.join[activeRoomId]) {
            const roomTimeline = data.rooms.join[activeRoomId].timeline;
            if (roomTimeline && roomTimeline.events) {
              for (const event of roomTimeline.events) {
                if (event.type === 'm.room.message') {
                  appendMessageEvent(event);
                  scrollToBottom();
                }
              }
            }
          }
        }
      } catch (e) {
        // Network drop or timeout, cool down before retrying
        await new Promise(r => setTimeout(r, 5000));
      }
  
      if (sessionState.accessToken) {
        syncInterval = setTimeout(poll, 1000);
      }
    };
  
    poll();
  }
  
  function stopSync() {
    if (syncInterval) {
      clearTimeout(syncInterval);
      syncInterval = null;
    }
  }