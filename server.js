import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { MongoClient } from 'mongodb';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/free-cluely';

// MongoDB connection
const mongoClient = new MongoClient(MONGO_URI);
let db = null;
let usersCollection = null;
let friendshipsCollection = null;
let chatHistoryCollection = null;
let friendRequestsCollection = null;

// In-memory storage (session-based only)
const userConnections = new Map(); // username -> ws connection
const lastSeen = new Map(); // username -> timestamp

// Connect to MongoDB
async function connectMongoDB() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('free-cluely');
    usersCollection = db.collection('users');
    friendshipsCollection = db.collection('friendships');
    chatHistoryCollection = db.collection('chatHistory');
    friendRequestsCollection = db.collection('friendRequests');

    // Create indexes for faster queries
    await usersCollection.createIndex({ username: 1 }, { unique: true });
    await friendshipsCollection.createIndex({ username: 1 });
    await chatHistoryCollection.createIndex({ conversationKey: 1 });
    await friendRequestsCollection.createIndex({ toUser: 1 });

    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

// Middleware
app.use(cors());
app.use(express.json());

// Routes
// Generate unique 8-digit ID
function generateUniqueId() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const existingUser = await usersCollection.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcryptjs.hash(password, 10);
    const userId = generateUniqueId();
    
    await usersCollection.insertOne({
      username,
      password: hashedPassword,
      userId,
      createdAt: new Date(),
    });

    // Initialize empty friends array
    await friendshipsCollection.insertOne({
      username,
      userId,
      friends: [],
    });

    const token = jwt.sign({ username, userId }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username, userId });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await usersCollection.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'User not found', userNotFound: true });
    }

    const validPassword = await bcryptjs.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign({ username, userId: user.userId }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username, userId: user.userId });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const user = await usersCollection.findOne({ username });
    if (user) {
      res.json({ username: user.username, userId: user.userId });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user by ID
app.get('/api/users-by-id/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await usersCollection.findOne({ userId });
    if (user) {
      res.json({ username: user.username, userId: user.userId, isOnline: userConnections.has(user.username) });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Debug: Get all friend requests in database
app.get('/api/debug/friend-requests', async (req, res) => {
  try {
    const allRequests = await friendRequestsCollection.find({}).toArray();
    res.json({ friendRequests: allRequests });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Debug: Get all users
app.get('/api/debug/users', async (req, res) => {
  try {
    const allUsers = await usersCollection.find({}).project({username: 1, userId: 1}).toArray();
    res.json({ users: allUsers });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Debug: Get database state
app.get('/api/debug/state', async (req, res) => {
  try {
    const allUsers = await usersCollection.find({}).project({username: 1, userId: 1}).toArray();
    const allRequests = await friendRequestsCollection.find({}).toArray();
    const onlineUsers = Array.from(userConnections.keys());
    res.json({ 
      users: allUsers,
      friendRequests: allRequests,
      onlineUsers: onlineUsers
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// REST API endpoints for friend requests (HTTP fallback for WebSocket issues)
app.get('/api/friend-requests/incoming/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const requestsDoc = await friendRequestsCollection.findOne({ toUser: username });
    
    const requests = (requestsDoc?.requests || []).map(req => {
      if (typeof req === 'string') {
        return { sender: req, sentAt: new Date() };
      } else if (req.sender) {
        return { sender: req.sender, sentAt: req.sentAt || new Date() };
      }
      return req;
    });
    
    res.json({ requests, count: requests.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/friend-requests/outgoing/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const sentTo = await friendRequestsCollection.find({
      $or: [
        { 'requests.sender': username },
        { 'requests': username }
      ]
    }).toArray();
    
    const outgoing = sentTo.map(doc => {
      const userRequest = doc.requests.find(r => {
        if (typeof r === 'string') return r === username;
        return r.sender === username;
      });
      
      return {
        recipient: doc.toUser,
        sentAt: (typeof userRequest === 'object' ? userRequest?.sentAt : null) || new Date(),
      };
    });
    
    res.json({ outgoing, count: outgoing.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/friends/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const userFriends = await friendshipsCollection.findOne({ username });
    const friends = userFriends?.friends || [];
    
    const friendsData = friends.map((friend) => ({
      username: friend,
      online: userConnections.has(friend),
      lastSeen: lastSeen.get(friend) || new Date(),
    }));
    
    res.json({ friends: friendsData, count: friendsData.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Migrate old string requests to new object format
app.post('/api/debug/migrate-requests', async (req, res) => {
  try {
    const allRequests = await friendRequestsCollection.find({}).toArray();
    let migratedCount = 0;
    
    for (const doc of allRequests) {
      const migratedRequests = doc.requests.map(req => {
        if (typeof req === 'string') {
          migratedCount++;
          return { sender: req, sentAt: new Date() };
        }
        return req;
      });
      
      await friendRequestsCollection.updateOne(
        { _id: doc._id },
        { $set: { requests: migratedRequests } }
      );
    }
    
    res.json({ 
      message: `Migrated ${migratedCount} requests to new format`,
      totalDocuments: allRequests.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/online-users', (req, res) => {
  const onlineUsers = Array.from(userConnections.keys());
  res.json({ onlineUsers });
});

// Message HTTP endpoints (fallback for WebSocket issues on Render)
app.post('/api/messages/send', async (req, res) => {
  try {
    const { from, to, content } = req.body;
    
    if (!from || !to || !content) {
      return res.status(400).json({ error: 'from, to, and content required' });
    }
    
    const conversationKey = [from, to].sort().join('-');
    const messageObj = {
      conversationKey,
      from,
      to,
      content,
      timestamp: new Date(),
      read: false,
      readAt: null,
    };
    
    // Save to MongoDB
    const result = await chatHistoryCollection.insertOne(messageObj);
    
    console.log(`💬 Message saved: ${from} → ${to}`);
    
    // Try to send via WebSocket if recipient is online
    const toUser = userConnections.get(to);
    if (toUser && toUser.readyState === WebSocket.OPEN) {
      toUser.send(JSON.stringify({
        type: 'message',
        from,
        content,
        timestamp: messageObj.timestamp,
        read: false,
        messageId: result.insertedId?.toString(),
      }));
      console.log(`✓ WebSocket: Sent to ${to}`);
    } else {
      console.log(`⚠ ${to} is offline, message will be retrieved on next poll`);
    }
    
    res.json({ 
      success: true, 
      messageId: result.insertedId?.toString(),
      timestamp: messageObj.timestamp 
    });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get messages for a conversation
app.get('/api/messages/:username/:withUser', async (req, res) => {
  try {
    const { username, withUser } = req.params;
    const conversationKey = [username, withUser].sort().join('-');
    
    const messages = await chatHistoryCollection
      .find({ conversationKey })
      .sort({ timestamp: 1 })
      .toArray();
    
    console.log(`📬 Fetched ${messages.length} messages for ${username} ↔ ${withUser}`);
    
    res.json({ messages, count: messages.length });
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Mark message as read
app.post('/api/messages/read', async (req, res) => {
  try {
    const { messageId, readBy } = req.body;
    
    if (!messageId || !readBy) {
      return res.status(400).json({ error: 'messageId and readBy required' });
    }
    
    const { ObjectId } = require('mongodb');
    const readTimestamp = new Date();
    
    // Update message status
    const result = await chatHistoryCollection.updateOne(
      { _id: new ObjectId(messageId) },
      { $set: { read: true, readAt: readTimestamp, readBy } }
    );
    
    if (result.modifiedCount > 0) {
      console.log(`✓ Message ${messageId} marked as read by ${readBy}`);
      
      // Get the message to find sender
      const message = await chatHistoryCollection.findOne({ _id: new ObjectId(messageId) });
      if (message) {
        // Try to notify sender via WebSocket
        const senderConn = userConnections.get(message.from);
        if (senderConn && senderConn.readyState === WebSocket.OPEN) {
          senderConn.send(JSON.stringify({
            type: 'read-receipt',
            messageId: messageId,
            readBy,
            readAt: readTimestamp,
          }));
          console.log(`✓ WebSocket: Sent read receipt to ${message.from}`);
        }
      }
    }
    
    res.json({ success: result.modifiedCount > 0 });
  } catch (err) {
    console.error('Error marking message as read:', err);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// Get unread messages for a user (for notifications)
app.get('/api/messages/unread/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const unreadMessages = await chatHistoryCollection
      .find({ to: username, read: false })
      .sort({ timestamp: -1 })
      .toArray();
    
    res.json({ unreadMessages, count: unreadMessages.length });
  } catch (err) {
    console.error('Error fetching unread messages:', err);
    res.status(500).json({ error: 'Failed to fetch unread messages' });
  }
});

// Clear chat history (HTTP endpoint)
app.post('/api/messages/clear', async (req, res) => {
  try {
    const { username, withUser } = req.body;
    
    if (!username || !withUser) {
      return res.status(400).json({ error: 'username and withUser required' });
    }
    
    const conversationKey = [username, withUser].sort().join('-');
    
    // Delete all messages in this conversation from MongoDB
    const result = await chatHistoryCollection.deleteMany({ conversationKey });
    
    console.log(`🗑️ Cleared chat between ${username} and ${withUser}: deleted ${result.deletedCount} messages`);
    
    // Try to notify the other user via WebSocket if online
    const otherUser = userConnections.get(withUser);
    if (otherUser && otherUser.readyState === WebSocket.OPEN) {
      otherUser.send(JSON.stringify({
        type: 'clear-chat',
        from: username,
        to: withUser,
      }));
      console.log(`✓ WebSocket: Notified ${withUser} about cleared chat`);
    }
    
    res.json({ 
      success: true, 
      deletedCount: result.deletedCount,
      message: `Cleared ${result.deletedCount} messages from chat with ${withUser}`
    });
  } catch (err) {
    console.error('Error clearing chat:', err);
    res.status(500).json({ error: 'Failed to clear chat' });
  }
});

// Health check endpoint for Render
app.get('/health', async (req, res) => {
  try {
    // Test MongoDB connection
    await db.admin().ping();
    
    res.json({ 
      status: 'ok',
      timestamp: new Date(),
      uptime: process.uptime(),
      mongodb: 'connected',
      onlineUsers: userConnections.size
    });
  } catch (err) {
    res.status(503).json({ 
      status: 'error',
      timestamp: new Date(),
      uptime: process.uptime(),
      mongodb: 'disconnected',
      error: err.message
    });
  }
});

// WebSocket handling
wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'auth':
          currentUser = message.username;
          userConnections.set(currentUser, ws);
          lastSeen.set(currentUser, new Date());
          broadcastUserStatus(currentUser, true);
          console.log(`✅ User ${currentUser} authenticated`);
          
          // Send pending and outgoing requests immediately after auth is set
          // Use process.nextTick to ensure currentUser is set
          process.nextTick(() => {
            sendPendingRequests(currentUser, ws);
            sendOutgoingRequests(currentUser, ws);
          });
          break;

        case 'message':
          handleChatMessage(message);
          break;

        case 'typing':
          broadcastTypingStatus(message.from, message.to, message.typing);
          break;

        case 'friend-request':
          handleFriendRequest(message.from, message.to, ws, currentUser);
          break;

        case 'friend-response':
          handleFriendResponse(message.from, message.to, message.accept, ws, currentUser);
          break;

        case 'cancel-friend-request':
          handleCancelFriendRequest(message.from, message.to, ws, currentUser);
          break;

        case 'get-friends':
          sendFriendsList(currentUser, ws);
          break;

        case 'get-chat-history':
          sendChatHistory(currentUser, message.with, ws);
          break;

        case 'clear-chat':
          handleClearChat(message.from, message.to);
          break;

        case 'get-online':
          sendOnlineUsers(ws);
          break;

        case 'get-pending':
          console.log(`📨 get-pending received. currentUser:`, currentUser);
          if (!currentUser) {
            console.log('❌ get-pending received BEFORE auth, ignoring');
            break;
          }
          sendPendingRequests(currentUser, ws);
          break;

        case 'get-outgoing':
          console.log(`📨 get-outgoing received. currentUser:`, currentUser);
          if (!currentUser) {
            console.log('❌ get-outgoing received BEFORE auth, ignoring');
            break;
          }
          sendOutgoingRequests(currentUser, ws);
          break;

        case 'mark-read':
          handleMarkRead(message.messageId, message.to);
          break;

        default:
          console.log('Unknown message type:', message.type);
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  ws.on('close', () => {
    if (currentUser) {
      userConnections.delete(currentUser);
      lastSeen.set(currentUser, new Date());
      broadcastUserStatus(currentUser, false);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

function handleChatMessage(message) {
  const { from, to, content } = message;
  
  // Create conversation key (sorted so same conversation has same key)
  const conversationKey = [from, to].sort().join('-');
  
  // Save message to MongoDB
  const messageObj = {
    conversationKey,
    from,
    to,
    content,
    timestamp: new Date(),
    read: false,
    readAt: null,
  };
  
  chatHistoryCollection.insertOne(messageObj).catch(err => {
    console.error('Error saving message:', err);
  });
  
  // Send to recipient if online
  const toUser = userConnections.get(to);
  if (toUser) {
    toUser.send(JSON.stringify({
      type: 'message',
      from,
      content,
      timestamp: messageObj.timestamp,
      read: false,
      readAt: null,
      messageId: messageObj._id?.toString(),
    }));
  }
}

function broadcastTypingStatus(from, to, typing) {
  const toUser = userConnections.get(to);

  if (toUser) {
    toUser.send(JSON.stringify({
      type: 'typing',
      from,
      typing,
    }));
  }
}

async function handleFriendRequest(from, to, ws, currentUser) {
  try {
    console.log(`\n=== FRIEND REQUEST FLOW ===`);
    console.log(`FROM: ${from}`);
    console.log(`TO (received): ${to}`);
    
    // Validate sender
    if (!currentUser || currentUser !== from) {
      console.log(`❌ Unauthorized: currentUser (${currentUser}) != from (${from})`);
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      return;
    }
    
    const senderUser = await usersCollection.findOne({ username: from });
    if (!senderUser) {
      console.log(`❌ Sender ${from} not found`);
      ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
      return;
    }
    
    // 'to' might be an 8-digit ID, try to resolve it to username
    let toUsername = to;
    
    // Check if 'to' looks like an ID (8 digits)
    if (/^\d{8}$/.test(to)) {
      console.log(`✓ "${to}" looks like an 8-digit ID`);
      const user = await usersCollection.findOne({ userId: to });
      if (!user) {
        console.log(`❌ User ID ${to} not found`);
        ws.send(JSON.stringify({ type: 'error', message: `User with ID ${to} not found` }));
        return;
      }
      toUsername = user.username;
      console.log(`✓ Resolved ID ${to} to username: ${toUsername}`);
    }
    
    // Prevent self-requests
    if (from === toUsername) {
      console.log(`❌ Cannot send friend request to yourself`);
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot send request to yourself' }));
      return;
    }
    
    // Check if already friends
    const friendship = await friendshipsCollection.findOne({ username: from });
    if (friendship?.friends?.includes(toUsername)) {
      console.log(`❌ Already friends with ${toUsername}`);
      ws.send(JSON.stringify({ type: 'error', message: 'Already friends with this user' }));
      return;
    }
    
    // Check if request already exists
    const existingRequest = await friendRequestsCollection.findOne({ toUser: toUsername, 'requests.sender': from });
    if (existingRequest) {
      console.log(`❌ Request already sent to ${toUsername}`);
      ws.send(JSON.stringify({ type: 'error', message: 'Request already sent' }));
      return;
    }

    const timestamp = new Date();
    const requestObj = { sender: from, sentAt: timestamp };
    
    // Store request with full details (Discord-like structure)
    const result = await friendRequestsCollection.updateOne(
      { toUser: toUsername },
      { $push: { requests: requestObj } },
      { upsert: true }
    );
    
    console.log(`✓ Stored request in DB`);
    console.log(`  DB operation:`, {matched: result.matchedCount, modified: result.modifiedCount, upserted: result.upsertedId});

    // Verify it was stored
    const stored = await friendRequestsCollection.findOne({ toUser: toUsername });
    console.log(`✓ Verified in DB:`, stored);

    // Notify sender
    ws.send(JSON.stringify({
      type: 'request-sent',
      to: toUsername,
      status: 'pending',
      sentAt: timestamp,
      message: `Friend request sent to ${toUsername}`,
    }));
    console.log(`✓ Notified sender: ${from}`);

    // Send to recipient if online
    const toUserConn = userConnections.get(toUsername);
    if (toUserConn && toUserConn.readyState === 1) {
      toUserConn.send(JSON.stringify({
        type: 'incoming-request',
        from,
        fromId: senderUser.userId,
        sentAt: timestamp,
      }));
      console.log(`✓ Notified recipient: ${toUsername}`);
    } else {
      console.log(`⚠ Recipient ${toUsername} is offline (will see on next login)`);
    }
  } catch (err) {
    console.error(`❌ Error in handleFriendRequest:`, err);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to send request' }));
  }
}

function handleFriendResponse(from, to, accept, ws, currentUser) {
  try {
    // Validate authorization
    if (!currentUser || currentUser !== from) {
      console.log(`❌ Unauthorized: currentUser (${currentUser}) != from (${from})`);
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      return;
    }
    
    console.log(`\n=== FRIEND RESPONSE ===`);
    console.log(`Recipient: ${from}, Sender: ${to}, Accept: ${accept}`);
    
    // Remove from pending requests
    friendRequestsCollection.updateOne(
      { toUser: from },
      { $pull: { 'requests': { sender: to } } }
    ).then(removeResult => {
      console.log(`✓ Removed request from pending:`, {matched: removeResult.matchedCount, modified: removeResult.modifiedCount});
    }).catch(err => {
      console.error('Error removing friend request:', err);
    });

    if (accept) {
      console.log(`✓ Request accepted - adding to friends`);
      
      // Add to friends in MongoDB (both directions)
      friendshipsCollection.updateOne(
        { username: from },
        { $addToSet: { friends: to } },
        { upsert: true }
      ).catch(err => {
        console.error('Error adding friend:', err);
      });

      friendshipsCollection.updateOne(
        { username: to },
        { $addToSet: { friends: from } },
        { upsert: true }
      ).catch(err => {
        console.error('Error adding friend:', err);
      });

      // Notify both users
      const fromUser = userConnections.get(from);
      const toUser = userConnections.get(to);

      const responseMessage = JSON.stringify({
        type: 'friend-added',
        friendUsername: to,
        status: 'accepted',
        addedAt: new Date(),
      });

      if (fromUser) {
        fromUser.send(responseMessage);
        console.log(`✓ Notified ${from}: friendship accepted`);
      }

      if (toUser) {
        toUser.send(JSON.stringify({
          type: 'friend-added',
          friendUsername: from,
          status: 'accepted',
          addedAt: new Date(),
        }));
        console.log(`✓ Notified ${to}: friendship accepted`);
      }

      console.log(`✅ ${from} and ${to} are now friends\n`);
    } else {
      console.log(`✓ Request declined`);
      
      // Notify sender that request was declined
      const toUser = userConnections.get(to);
      if (toUser) {
        toUser.send(JSON.stringify({
          type: 'request-declined',
          declinedBy: from,
          declinedAt: new Date(),
        }));
        console.log(`✓ Notified ${to}: request declined by ${from}`);
      }

      console.log(`✅ ${from} declined friend request from ${to}\n`);
    }
  } catch (err) {
    console.error('❌ Error in handleFriendResponse:', err);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to respond to request' }));
  }
}

async function handleCancelFriendRequest(from, to, ws, currentUser) {
  try {
    // Validate authorization
    if (!currentUser || currentUser !== from) {
      console.log(`❌ Unauthorized: currentUser (${currentUser}) != from (${from})`);
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      return;
    }
    
    console.log(`\n=== CANCEL FRIEND REQUEST ===`);
    console.log(`Sender: ${from}, Target: ${to}`);
    
    // Resolve ID to username if needed
    let toUsername = to;
    if (/^\d{8}$/.test(to)) {
      const user = await usersCollection.findOne({ userId: to });
      if (!user) {
        ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
        return;
      }
      toUsername = user.username;
    }
    
    // Remove the pending request
    const result = await friendRequestsCollection.updateOne(
      { toUser: toUsername },
      { $pull: { 'requests': { sender: from } } }
    );
    
    if (result.modifiedCount === 0) {
      console.log(`❌ No pending request found`);
      ws.send(JSON.stringify({ type: 'error', message: 'No pending request to cancel' }));
      return;
    }
    
    console.log(`✓ Request cancelled`);
    
    // Notify sender
    ws.send(JSON.stringify({
      type: 'request-cancelled',
      to: toUsername,
      cancelledAt: new Date(),
      message: `Friend request to ${toUsername} cancelled`,
    }));
    
    // Notify recipient if online
    const toUserConn = userConnections.get(toUsername);
    if (toUserConn && toUserConn.readyState === 1) {
      toUserConn.send(JSON.stringify({
        type: 'request-cancelled-notification',
        from,
        cancelledAt: new Date(),
      }));
      console.log(`✓ Notified ${toUsername}: request cancelled by ${from}`);
    }
    
    console.log(`✅ Request cancelled: ${from} → ${toUsername}\n`);
  } catch (err) {
    console.error('❌ Error in handleCancelFriendRequest:', err);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to cancel request' }));
  }
}

function handleMarkRead(messageId, to) {
  const { ObjectId } = require('mongodb');
  const readTimestamp = new Date();
  
  try {
    chatHistoryCollection.updateOne(
      { _id: new ObjectId(messageId) },
      { $set: { read: true, readAt: readTimestamp } }
    ).then(() => {
      // Get the message to find the sender
      chatHistoryCollection.findOne({ _id: new ObjectId(messageId) }).then(msg => {
        if (msg) {
          const senderConnection = userConnections.get(msg.from);
          if (senderConnection) {
            senderConnection.send(JSON.stringify({
              type: 'read-receipt',
              messageId: messageId.toString(),
              readBy: to,
              readAt: readTimestamp,
            }));
          }
        }
      });
    }).catch(err => {
      console.error('Error marking message as read:', err);
    });
  } catch (err) {
    console.error('Error in handleMarkRead:', err);
  }
}

async function sendFriendsList(username, ws) {
  try {
    const userFriends = await friendshipsCollection.findOne({ username });
    const friends = userFriends?.friends || [];
    
    const friendsData = friends.map((friend) => ({
      username: friend,
      online: userConnections.has(friend),
      lastSeen: lastSeen.get(friend) || new Date(),
    }));

    ws.send(JSON.stringify({
      type: 'friends-list',
      friends: friendsData,
    }));
  } catch (err) {
    console.error('Error getting friends list:', err);
  }
}

function sendOnlineUsers(ws) {
  const onlineUsers = Array.from(userConnections.keys());
  ws.send(JSON.stringify({
    type: 'online-users',
    users: onlineUsers,
  }));
}

async function sendPendingRequests(username, ws) {
  try {
    console.log(`\n=== SEND INCOMING REQUESTS FOR: ${username} ===`);
    
    const requestsDoc = await friendRequestsCollection.findOne({ toUser: username });
    console.log(`Query: {toUser: "${username}"}`);
    console.log(`Result:`, requestsDoc);
    
    // Normalize requests to consistent format (handle both old string format and new object format)
    const requests = (requestsDoc?.requests || []).map(req => {
      if (typeof req === 'string') {
        // Legacy format: just username string
        return { sender: req, sentAt: new Date() };
      } else if (req.sender) {
        // New Discord-like format: {sender, sentAt}
        return { sender: req.sender, sentAt: req.sentAt || new Date() };
      }
      return req;
    });
    
    console.log(`📥 Sending incoming requests to ${username}:`, requests);
    
    const message = JSON.stringify({
      type: 'pending-requests',
      requests: requests,
      count: requests.length,
    });
    
    console.log(`WebSocket readyState: ${ws.readyState} (1=OPEN, 2=CLOSING, 3=CLOSED)`);
    ws.send(message);
    
    console.log(`✅ Sent to client: ${message}\n`);
  } catch (err) {
    console.error('Error getting pending requests:', err);
  }
}

async function sendOutgoingRequests(username, ws) {
  try {
    console.log(`\n=== SEND OUTGOING REQUESTS FROM: ${username} ===`);
    
    // Find all documents where this user sent requests
    // Handle both old format (string) and new format (object with sender field)
    const sentTo = await friendRequestsCollection.find({
      $or: [
        { 'requests.sender': username },  // New object format
        { 'requests': username }          // Old string format (backward compatibility)
      ]
    }).toArray();
    
    console.log(`Found ${sentTo.length} documents with requests from ${username}`);
    
    // Extract outgoing requests with timestamps
    const outgoing = sentTo.map(doc => {
      // Find requests sent by this user (handle both formats)
      const userRequest = doc.requests.find(r => {
        if (typeof r === 'string') return r === username;
        return r.sender === username;
      });
      
      return {
        recipient: doc.toUser,
        sentAt: (typeof userRequest === 'object' ? userRequest?.sentAt : null) || new Date(),
      };
    });
    
    console.log(`📤 Sending outgoing requests from ${username}:`, outgoing);
    
    const message = JSON.stringify({
      type: 'outgoing-requests',
      outgoing: outgoing,
      count: outgoing.length,
    });
    
    console.log(`WebSocket readyState: ${ws.readyState} (1=OPEN, 2=CLOSING, 3=CLOSED)`);
    ws.send(message);
    
    console.log(`✅ Sent to client: ${message}\n`);
  } catch (err) {
    console.error('Error getting outgoing requests:', err);
  }
}

async function sendChatHistory(username, withUser, ws) {
  try {
    const conversationKey = [username, withUser].sort().join('-');
    const messages = await chatHistoryCollection
      .find({ conversationKey })
      .sort({ timestamp: 1 })
      .toArray();

    ws.send(JSON.stringify({
      type: 'chat-history',
      messages: messages,
      with: withUser,
    }));
  } catch (err) {
    console.error('Error getting chat history:', err);
  }
}

function handleClearChat(from, to) {
  const conversationKey = [from, to].sort().join('-');
  
  // Delete the chat history from MongoDB
  chatHistoryCollection.deleteMany({ conversationKey }).catch(err => {
    console.error('Error clearing chat:', err);
  });

  // Notify both users to clear their screens
  const fromUser = userConnections.get(from);
  const toUser = userConnections.get(to);

  const clearMessage = JSON.stringify({
    type: 'clear-chat',
    from,
    to,
  });

  if (fromUser && fromUser.readyState === WebSocket.OPEN) {
    fromUser.send(clearMessage);
  }

  if (toUser && toUser.readyState === WebSocket.OPEN) {
    toUser.send(clearMessage);
  }

  console.log(`Chat between ${from} and ${to} cleared`);
}

function broadcastUserStatus(username, online) {
  const message = JSON.stringify({
    type: 'user-status',
    username,
    online,
    timestamp: new Date(),
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

server.listen(PORT, () => {
  console.log(`🚀 Free Cluely Server running on http://localhost:${PORT}`);
  console.log(`🔧 Version: ${new Date().toISOString()}`);
});

// Connect to MongoDB on startup
connectMongoDB().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await mongoClient.close();
  process.exit(0);
});
