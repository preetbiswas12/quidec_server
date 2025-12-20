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
    await usersCollection.insertOne({
      username,
      password: hashedPassword,
      createdAt: new Date(),
    });

    // Initialize empty friends array
    await friendshipsCollection.insertOne({
      username,
      friends: [],
    });

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username });
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
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcryptjs.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const user = await usersCollection.findOne({ username });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isOnline = userConnections.has(username);
    const lastSeenTime = lastSeen.get(username) || user.createdAt;

    res.json({
      username,
      online: isOnline,
      lastSeen: lastSeenTime,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/online-users', (req, res) => {
  const onlineUsers = Array.from(userConnections.keys());
  res.json({ onlineUsers });
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
          break;

        case 'message':
          handleChatMessage(message);
          break;

        case 'typing':
          broadcastTypingStatus(message.from, message.to, message.typing);
          break;

        case 'friend-request':
          handleFriendRequest(message.from, message.to);
          break;

        case 'friend-response':
          handleFriendResponse(message.from, message.to, message.accept);
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
          sendPendingRequests(currentUser, ws);
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

function handleFriendRequest(from, to) {
  // Store pending request in MongoDB
  friendRequestsCollection.updateOne(
    { toUser: to },
    { $addToSet: { requests: from } },
    { upsert: true }
  ).catch(err => {
    console.error('Error saving friend request:', err);
  });

  const toUser = userConnections.get(to);
  if (toUser) {
    toUser.send(JSON.stringify({
      type: 'friend-request',
      from,
      timestamp: new Date(),
    }));
  }

  console.log(`Friend request from ${from} to ${to}`);
}

function handleFriendResponse(from, to, accept) {
  // Remove from pending requests
  friendRequestsCollection.updateOne(
    { toUser: from },
    { $pull: { requests: to } }
  ).catch(err => {
    console.error('Error removing friend request:', err);
  });

  if (accept) {
    // Add to friends in MongoDB
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

    if (toUser) {
      toUser.send(JSON.stringify({
        type: 'friend-request-response',
        from,
        accepted: true,
      }));
    }

    if (fromUser) {
      fromUser.send(JSON.stringify({
        type: 'friend-request-response',
        from: to,
        accepted: true,
      }));
    }

    console.log(`${from} and ${to} are now friends`);
  } else {
    console.log(`${to} declined friend request from ${from}`);
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
    const requestsDoc = await friendRequestsCollection.findOne({ toUser: username });
    const requests = requestsDoc?.requests || [];
    
    ws.send(JSON.stringify({
      type: 'pending-requests',
      requests: requests,
    }));
  } catch (err) {
    console.error('Error getting pending requests:', err);
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
