const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cors = require('cors');
const Jimp = require('jimp');
const pixelmatch = require('pixelmatch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MIDDLEWARE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ASTROMETRY_API_KEY = process.env.ASTROMETRY_API_KEY || 'colziljqtejtgxxg';
const HF_API_KEY = process.env.HF_API_KEY;
const TWITTER_CLIENT_ID = process.env.TWITTER_CLIENT_ID;
const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IN-MEMORY STORAGE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let communityPosts = [];
let userProfiles = {};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function getOrCreateUser(userId) {
    if (!userProfiles[userId]) {
        userProfiles[userId] = {
            userId: userId,
            username: 'Astronomer_' + Math.random().toString(36).substr(2, 5),
            bio: 'Exploring the cosmos 🌌',
            avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${userId}`,
            joinDate: Date.now(),
            postsCount: 0,
            commentsCount: 0,
            likesReceived: 0,
            discoveries: []
        };
    }
    return userProfiles[userId];
}

function countNestedComments(comments) {
    if (!comments || comments.length === 0) return 0;
    let count = comments.length;
    comments.forEach(comment => {
        count += countNestedComments(comment.replies);
    });
    return count;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCIENTIFIC HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getCalibrationResults(subId) {
    const statusUrl = `http://nova.astrometry.net/api/submissions/${subId}`;
    for (let i = 0; i < 20; i++) {
        const response = await axios.get(statusUrl);
        if (response.data.job_calibrations && response.data.job_calibrations.length > 0) {
            const jobId = response.data.jobs[0];
            const calRes = await axios.get(`http://nova.astrometry.net/api/jobs/${jobId}/calibration/`);
            return calRes.data;
        }
        console.log(`🔭 Solving coordinates... Attempt ${i + 1}/20`);
        await new Promise(res => setTimeout(res, 3000));
    }
    throw new Error("Astrometry solving timed out.");
}

async function performChangeDetection(userBuffer, nasaUrl) {
    try {
        const [userImg, nasaImg] = await Promise.all([
            Jimp.read(userBuffer),
            Jimp.read(nasaUrl)
        ]);
        userImg.resize(500, 500).greyscale();
        nasaImg.resize(500, 500).greyscale();
        const diffBuffer = Buffer.alloc(500 * 500 * 4);
        const numDiffPixels = pixelmatch(
            userImg.bitmap.data,
            nasaImg.bitmap.data,
            diffBuffer,
            500, 500,
            { threshold: 0.15 }
        );
        return numDiffPixels;
    } catch (e) {
        console.error("Comparison Error:", e.message);
        return 0;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DAO ROUTES INTEGRATION (Supabase)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
try {
  const daoRoutes = require('./routes/dao');
  app.use('/api/dao', daoRoutes);
  console.log('✅ Supabase DAO routes loaded successfully');
} catch (error) {
  console.warn('⚠️  DAO routes not found - using in-memory storage instead');
  console.warn('   To enable Supabase DAO: create ./routes/dao.js');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// USER PROFILE ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/users/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const user = getOrCreateUser(userId);
        
        const userPosts = communityPosts.filter(p => p.userId === userId);
        user.postsCount = userPosts.length;
        
        res.json(user);
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

app.put('/api/users/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const { username, bio, avatar } = req.body;
        
        const user = getOrCreateUser(userId);
        
        if (username) user.username = username;
        if (bio !== undefined) user.bio = bio;
        if (avatar) user.avatar = avatar;
        
        console.log(`✅ User profile updated: ${userId}`);
        res.json(user);
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

app.get('/api/users', (req, res) => {
    try {
        const users = Object.values(userProfiles);
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LEGACY IN-MEMORY DAO ENDPOINTS (Fallback if Supabase routes not available)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/posts', (req, res) => {
    try {
        const sortedPosts = [...communityPosts].sort((a, b) => b.timestamp - a.timestamp);
        console.log(`📋 Fetched ${sortedPosts.length} posts`);
        res.json(sortedPosts);
    } catch (error) {
        console.error('Error fetching posts:', error);
        res.status(500).json({ error: 'Failed to fetch posts' });
    }
});

app.post('/api/posts', (req, res) => {
    try {
        const { text, image, userId } = req.body;
        
        if (!text && !image) {
            return res.status(400).json({ error: 'Text or image required' });
        }
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }

        const user = getOrCreateUser(userId);

        const newPost = {
            id: `post-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            text: text || '',
            image: image || null,
            likes: 0,
            likedBy: [],
            comments: [],
            userId: userId,
            author: user.username,
            authorAvatar: user.avatar,
            timestamp: Date.now(),
            timeString: new Date().toLocaleString()
        };

        communityPosts.unshift(newPost);
        user.postsCount++;
        
        console.log(`✅ Post created: ${newPost.id} by ${user.username}`);
        res.json(newPost);
    } catch (error) {
        console.error('Post creation error:', error);
        res.status(500).json({ error: 'Failed to create post' });
    }
});

app.post('/api/posts/:id/like', (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'userId required' });
        }

        const post = communityPosts.find(p => p.id === id);
        
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const alreadyLiked = post.likedBy.includes(userId);

        if (alreadyLiked) {
            post.likes = Math.max(0, post.likes - 1);
            post.likedBy = post.likedBy.filter(u => u !== userId);
        } else {
            post.likes++;
            post.likedBy.push(userId);
        }

        res.json(post);
    } catch (error) {
        console.error('Like error:', error);
        res.status(500).json({ error: 'Failed to update like' });
    }
});

app.get('/api/posts/:id/comments', (req, res) => {
    try {
        const { id } = req.params;
        const post = communityPosts.find(p => p.id === id);
        
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        res.json(post.comments || []);
    } catch (error) {
        console.error('Error fetching comments:', error);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

app.post('/api/posts/:id/comments', (req, res) => {
    try {
        const { id } = req.params;
        const { text, userId, parentId } = req.body;

        if (!text || !userId) {
            return res.status(400).json({ error: 'Text and userId required' });
        }

        const post = communityPosts.find(p => p.id === id);
        
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const user = getOrCreateUser(userId);

        const newComment = {
            id: `comment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            text,
            userId,
            author: user.username,
            likes: 0,
            likedBy: [],
            timestamp: Date.now(),
            timeString: new Date().toLocaleString(),
            replies: []
        };

        if (parentId) {
            const findAndAddReply = (comments) => {
                for (let comment of comments) {
                    if (comment.id === parentId) {
                        comment.replies.push(newComment);
                        return true;
                    }
                    if (comment.replies && findAndAddReply(comment.replies)) {
                        return true;
                    }
                }
                return false;
            };
            
            if (!findAndAddReply(post.comments)) {
                return res.status(404).json({ error: 'Parent comment not found' });
            }
        } else {
            post.comments.push(newComment);
        }

        user.commentsCount++;
        
        res.json(newComment);
    } catch (error) {
        console.error('Comment creation error:', error);
        res.status(500).json({ error: 'Failed to create comment' });
    }
});

app.post('/api/posts/:postId/comments/:commentId/like', (req, res) => {
    try {
        const { postId, commentId } = req.params;
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'userId required' });
        }

        const post = communityPosts.find(p => p.id === postId);
        
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const findAndToggleLike = (comments) => {
            for (let comment of comments) {
                if (comment.id === commentId) {
                    const alreadyLiked = comment.likedBy.includes(userId);
                    
                    if (alreadyLiked) {
                        comment.likes = Math.max(0, comment.likes - 1);
                        comment.likedBy = comment.likedBy.filter(u => u !== userId);
                    } else {
                        comment.likes++;
                        comment.likedBy.push(userId);
                    }
                    
                    return comment;
                }
                
                if (comment.replies) {
                    const found = findAndToggleLike(comment.replies);
                    if (found) return found;
                }
            }
            return null;
        };

        const updatedComment = findAndToggleLike(post.comments);
        
        if (!updatedComment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        res.json(updatedComment);
    } catch (error) {
        console.error('Comment like error:', error);
        res.status(500).json({ error: 'Failed to update comment like' });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AI & SCIENTIFIC ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/chat', async (req, res) => {
  const { prompt, maxTokens = 300, temperature = 0.7, topP = 0.9 } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  if (!HF_API_KEY) {
    return res.status(500).json({ 
      error: 'HF_API_KEY not configured. Please set it in .env file.' 
    });
  }

  try {
    const response = await fetch(
      'https://router.huggingface.co/featherless-ai/v1/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'AstroMLab/AstroSage-8B',
          prompt,
          max_tokens: maxTokens,
          temperature,
          top_p: topP,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Chat API error: ${response.statusText}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/identify', async (req, res) => {
    if (!process.env.HF_TOKEN) {
        return res.json({ description: "A celestial object with bright stellar regions." });
    }
    
    try {
        const response = await fetch(
            "https://router.huggingface.co/v1/chat/completions",
            {
                headers: {
                    Authorization: `Bearer ${process.env.HF_API_KEY}`,
                    "Content-Type": "application/json",
                },
                method: "POST",
                body: JSON.stringify({
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: "Describe this celestial object in one sentence.",
                                },
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: req.body.image,
                                    },
                                },
                            ],
                        },
                    ],
                    model: "moonshotai/Kimi-K2.5:novita",
                }),
            }
        );
        
        const result = await response.json();
        const description = result.choices?.[0]?.message?.content || "Celestial structure";
        
        res.json({ description });
    } catch (e) {
        res.status(500).json({ error: "Vision ID failed: " + e.message });
    }
});

app.post('/api/analyze-discovery', async (req, res) => {
    console.log("🚀 Starting Discovery Pipeline...");
    try {
        const { imageBase64 } = req.body;
        const imageBuffer = Buffer.from(imageBase64, 'base64');

        const login = await axios.post(
            'http://nova.astrometry.net/api/login', 
            `request-json=${JSON.stringify({ "apikey": ASTROMETRY_API_KEY })}`
        );
        const session = login.data.session;
        
        const form = new FormData();
        form.append('request-json', JSON.stringify({ session, publicly_visible: 'n' }));
        form.append('file', imageBuffer, { filename: 'observation.jpg' });
        
        const upload = await axios.post('http://nova.astrometry.net/api/upload', form, { headers: form.getHeaders() });
        const calibration = await getCalibrationResults(upload.data.subid);
        
        const nasaUrl = `https://skyview.gsfc.nasa.gov/cgi-bin/images?survey=sdssi&position=${calibration.ra},${calibration.dec}&size=0.1&pixels=500`;
        const diffCount = await performChangeDetection(imageBuffer, nasaUrl);
        const isAnomaly = diffCount > 1500;

        res.json({
            coords: { ra: calibration.ra.toFixed(4), dec: calibration.dec.toFixed(4) },
            historicalImage: nasaUrl,
            discovery: isAnomaly ? `ANOMALY: Found ${diffCount} pixel variances.` : "Region stable.",
            type: isAnomaly ? "SUPERNOVA" : "GALAXY",
            rawScore: diffCount
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TWITTER AUTHENTICATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/auth/twitter/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        
        if (!code) {
            return res.redirect(`${FRONTEND_URL}?error=no_code`);
        }

        const tokenResponse = await axios.post(
            'https://api.twitter.com/2/oauth2/token',
            new URLSearchParams({
                code,
                grant_type: 'authorization_code',
                client_id: TWITTER_CLIENT_ID,
                redirect_uri: `${FRONTEND_URL}/auth/twitter/callback`,
                code_verifier: 'challenge'
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString('base64')}`
                }
            }
        );

        const { access_token } = tokenResponse.data;

        const userResponse = await axios.get('https://api.twitter.com/2/users/me', {
            headers: {
                'Authorization': `Bearer ${access_token}`
            }
        });

        const twitterUser = userResponse.data.data;

        const userId = `twitter-${twitterUser.id}`;
        const user = getOrCreateUser(userId);
        user.username = twitterUser.username;
        user.twitterId = twitterUser.id;
        user.method = 'twitter';

        console.log(`✅ Twitter auth successful: ${user.username}`);

        const userData = encodeURIComponent(JSON.stringify({
            id: userId,
            username: user.username,
            method: 'twitter',
            avatar: user.avatar
        }));

        res.redirect(`${FRONTEND_URL}?auth=success&user=${userData}`);

    } catch (error) {
        console.error('❌ Twitter OAuth error:', error.message);
        res.redirect(`${FRONTEND_URL}?error=auth_failed`);
    }
});

app.get('/auth/me', (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        
        if (!userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const user = userProfiles[userId];
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(user);

    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Failed to get user' });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROOT ENDPOINT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/', (req, res) => {
    const totalComments = communityPosts.reduce((sum, post) => sum + countNestedComments(post.comments), 0);
    
    res.json({
        message: '🌌 AstroVision Discovery Backend',
        version: '3.0.0',
        features: ['User Profiles', 'Nested Comments', 'Community Board', 'AI Analysis'],
        status: {
            users: Object.keys(userProfiles).length,
            posts: communityPosts.length,
            comments: totalComments,
            hf_api_key: HF_API_KEY ? '✓' : '✗',
            astrometry_key: ASTROMETRY_API_KEY ? '✓' : '✗'
        }
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// START SERVER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.listen(PORT, () => {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🌌 AstroVision Backend v3.0`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🚀 Server: http://localhost:${PORT}`);
    console.log(`👥 Features: Profiles + Twitter Auth + Community`);
    console.log(`🔐 Twitter OAuth: ${TWITTER_CLIENT_ID ? '✓' : '✗'}`);
    console.log(`✅ All systems ready!`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});