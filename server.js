// server.js — AstroVision Backend
// DAO routes are merged directly into this file.
// No separate route files needed — works as-is on Render.

const express    = require('express');
const axios      = require('axios');
const FormData   = require('form-data');
const cors       = require('cors');
const Jimp       = require('jimp');
const pixelmatch = require('pixelmatch');
const multer     = require('multer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const ASTROMETRY_API_KEY    = process.env.ASTROMETRY_API_KEY || 'colziljqtejtgxxg';
const HF_API_KEY            = process.env.HF_API_KEY;
const TWITTER_CLIENT_ID     = process.env.TWITTER_CLIENT_ID;
const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;
const FRONTEND_URL          = process.env.FRONTEND_URL || 'http://localhost:3000';

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE  (service key — server-side only, never sent to browser)
// ─────────────────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────────────────────────────────────────────────────
// MULTER  (memory storage → streamed to Supabase Storage)
// ─────────────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    file.mimetype.startsWith('image/')
      ? cb(null, true)
      : cb(new Error('Only image files are allowed'), false);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY STORAGE  (user profiles + legacy posts)
// ─────────────────────────────────────────────────────────────────────────────
let communityPosts = [];
let userProfiles   = {};

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function getOrCreateUser(userId) {
  if (!userProfiles[userId]) {
    userProfiles[userId] = {
      userId,
      username:      'Astronomer_' + Math.random().toString(36).substr(2, 5),
      bio:           'Exploring the cosmos 🌌',
      avatar:        `https://api.dicebear.com/7.x/avataaars/svg?seed=${userId}`,
      joinDate:      Date.now(),
      postsCount:    0,
      commentsCount: 0,
      likesReceived: 0,
      discoveries:   [],
    };
  }
  return userProfiles[userId];
}

function countNestedComments(comments) {
  if (!comments || comments.length === 0) return 0;
  return comments.reduce((n, c) => n + 1 + countNestedComments(c.replies), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAO HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const formatTimeString = (timestamp) => {
  const date = new Date(timestamp);
  const diff = Math.floor((Date.now() - date) / 1000);
  if (diff < 60)     return 'Just now';
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
};

const buildNestedComments = (rows) => {
  const map   = {};
  const roots = [];
  rows.forEach(c => {
    map[c.id] = { ...c, replies: [], timeString: formatTimeString(c.created_at) };
  });
  rows.forEach(c => {
    if (c.parent_id && map[c.parent_id]) map[c.parent_id].replies.push(map[c.id]);
    else roots.push(map[c.id]);
  });
  return roots;
};

// ─────────────────────────────────────────────────────────────────────────────
// SCIENTIFIC HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function getCalibrationResults(subId) {
  const statusUrl = `http://nova.astrometry.net/api/submissions/${subId}`;
  for (let i = 0; i < 20; i++) {
    const response = await axios.get(statusUrl);
    if (response.data.job_calibrations && response.data.job_calibrations.length > 0) {
      const jobId  = response.data.jobs[0];
      const calRes = await axios.get(`http://nova.astrometry.net/api/jobs/${jobId}/calibration/`);
      return calRes.data;
    }
    console.log(`🔭 Solving coordinates... Attempt ${i + 1}/20`);
    await new Promise(res => setTimeout(res, 3000));
  }
  throw new Error('Astrometry solving timed out.');
}

async function performChangeDetection(userBuffer, nasaUrl) {
  try {
    const [userImg, nasaImg] = await Promise.all([Jimp.read(userBuffer), Jimp.read(nasaUrl)]);
    userImg.resize(500, 500).greyscale();
    nasaImg.resize(500, 500).greyscale();
    const diffBuffer = Buffer.alloc(500 * 500 * 4);
    return pixelmatch(userImg.bitmap.data, nasaImg.bitmap.data, diffBuffer, 500, 500, { threshold: 0.15 });
  } catch (e) {
    console.error('Comparison Error:', e.message);
    return 0;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DAO ROUTES — /api/dao/*   (Supabase-powered)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/dao/posts
app.get('/api/dao/posts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('posts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const posts = data.map(p => ({
      ...p,
      timeString: formatTimeString(p.created_at),
      comments:   [],
    }));

    res.json({ success: true, posts });
  } catch (err) {
    console.error('GET /api/dao/posts error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dao/posts
app.post('/api/dao/posts', upload.single('image'), async (req, res) => {
  try {
    const { text, userId, author } = req.body;
    let imageUrl = null;

    if (req.file) {
      const ext      = req.file.originalname.split('.').pop();
      const filePath = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('dao-images')
        .upload(filePath, req.file.buffer, { contentType: req.file.mimetype });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('dao-images')
        .getPublicUrl(filePath);

      imageUrl = publicUrl;
    }

    const { data, error } = await supabase
      .from('posts')
      .insert([{ user_id: userId, author, text, image: imageUrl, likes: 0, liked_by: [] }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, post: data });
  } catch (err) {
    console.error('POST /api/dao/posts error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dao/posts/:id/like
app.post('/api/dao/posts/:id/like', async (req, res) => {
  try {
    const { userId } = req.body;
    const postId     = req.params.id;

    const { data: post, error: fetchErr } = await supabase
      .from('posts').select('liked_by, likes').eq('id', postId).single();
    if (fetchErr) throw fetchErr;

    const likedBy  = post.liked_by || [];
    const hasLiked = likedBy.includes(userId);

    const { data, error } = await supabase
      .from('posts')
      .update({
        likes:    hasLiked ? post.likes - 1 : post.likes + 1,
        liked_by: hasLiked ? likedBy.filter(id => id !== userId) : [...likedBy, userId],
      })
      .eq('id', postId).select().single();

    if (error) throw error;
    res.json({ success: true, post: data });
  } catch (err) {
    console.error('POST /api/dao/posts/:id/like error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dao/posts/:id/comments
app.get('/api/dao/posts/:id/comments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('comments')
      .select('*')
      .eq('post_id', req.params.id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ success: true, comments: buildNestedComments(data) });
  } catch (err) {
    console.error('GET /api/dao/posts/:id/comments error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dao/posts/:id/comments
app.post('/api/dao/posts/:id/comments', async (req, res) => {
  try {
    const { userId, author, text, parentId = null } = req.body;

    const { data, error } = await supabase
      .from('comments')
      .insert([{
        post_id:   req.params.id,
        parent_id: parentId,
        user_id:   userId,
        author,
        text,
        likes:    0,
        liked_by: [],
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, comment: data });
  } catch (err) {
    console.error('POST /api/dao/posts/:id/comments error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dao/comments/:id/like
app.post('/api/dao/comments/:id/like', async (req, res) => {
  try {
    const { userId }  = req.body;
    const commentId   = req.params.id;

    const { data: comment, error: fetchErr } = await supabase
      .from('comments').select('liked_by, likes').eq('id', commentId).single();
    if (fetchErr) throw fetchErr;

    const likedBy  = comment.liked_by || [];
    const hasLiked = likedBy.includes(userId);

    const { data, error } = await supabase
      .from('comments')
      .update({
        likes:    hasLiked ? comment.likes - 1 : comment.likes + 1,
        liked_by: hasLiked ? likedBy.filter(id => id !== userId) : [...likedBy, userId],
      })
      .eq('id', commentId).select().single();

    if (error) throw error;
    res.json({ success: true, comment: data });
  } catch (err) {
    console.error('POST /api/dao/comments/:id/like error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// USER PROFILE ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/users/:userId', (req, res) => {
  try {
    const user      = getOrCreateUser(req.params.userId);
    user.postsCount = communityPosts.filter(p => p.userId === req.params.userId).length;
    res.json(user);
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/api/users/:userId', (req, res) => {
  try {
    const { username, bio, avatar } = req.body;
    const user = getOrCreateUser(req.params.userId);
    if (username)          user.username = username;
    if (bio !== undefined) user.bio      = bio;
    if (avatar)            user.avatar   = avatar;
    console.log(`✅ User profile updated: ${req.params.userId}`);
    res.json(user);
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.get('/api/users', (_req, res) => {
  try {
    res.json(Object.values(userProfiles));
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LEGACY IN-MEMORY POSTS  (backward-compat)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/posts', (_req, res) => {
  res.json([...communityPosts].sort((a, b) => b.timestamp - a.timestamp));
});

app.post('/api/posts', (req, res) => {
  const { text, image, userId } = req.body;
  if (!text && !image) return res.status(400).json({ error: 'Text or image required' });
  if (!userId)         return res.status(400).json({ error: 'User ID required' });

  const user    = getOrCreateUser(userId);
  const newPost = {
    id: `post-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    text: text || '', image: image || null, likes: 0, likedBy: [], comments: [],
    userId, author: user.username, authorAvatar: user.avatar,
    timestamp: Date.now(), timeString: new Date().toLocaleString(),
  };
  communityPosts.unshift(newPost);
  user.postsCount++;
  res.json(newPost);
});

app.post('/api/posts/:id/like', (req, res) => {
  const { userId } = req.body;
  const post       = communityPosts.find(p => p.id === req.params.id);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!post)   return res.status(404).json({ error: 'Post not found' });
  const liked = post.likedBy.includes(userId);
  if (liked) { post.likes = Math.max(0, post.likes - 1); post.likedBy = post.likedBy.filter(u => u !== userId); }
  else       { post.likes++; post.likedBy.push(userId); }
  res.json(post);
});

app.get('/api/posts/:id/comments', (req, res) => {
  const post = communityPosts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post.comments || []);
});

app.post('/api/posts/:id/comments', (req, res) => {
  const { text, userId, parentId } = req.body;
  const post = communityPosts.find(p => p.id === req.params.id);
  if (!text || !userId) return res.status(400).json({ error: 'Text and userId required' });
  if (!post)            return res.status(404).json({ error: 'Post not found' });

  const user       = getOrCreateUser(userId);
  const newComment = {
    id: `comment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    text, userId, author: user.username, likes: 0, likedBy: [],
    timestamp: Date.now(), timeString: new Date().toLocaleString(), replies: [],
  };

  const addReply = (comments) => {
    for (const c of comments) {
      if (c.id === parentId) { c.replies.push(newComment); return true; }
      if (c.replies && addReply(c.replies)) return true;
    }
    return false;
  };

  if (parentId) {
    if (!addReply(post.comments)) return res.status(404).json({ error: 'Parent comment not found' });
  } else {
    post.comments.push(newComment);
  }
  user.commentsCount++;
  res.json(newComment);
});

app.post('/api/posts/:postId/comments/:commentId/like', (req, res) => {
  const { userId } = req.body;
  const post       = communityPosts.find(p => p.id === req.params.postId);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!post)   return res.status(404).json({ error: 'Post not found' });

  const toggleLike = (comments) => {
    for (const c of comments) {
      if (c.id === req.params.commentId) {
        const liked = c.likedBy.includes(userId);
        if (liked) { c.likes = Math.max(0, c.likes - 1); c.likedBy = c.likedBy.filter(u => u !== userId); }
        else       { c.likes++; c.likedBy.push(userId); }
        return c;
      }
      if (c.replies) { const found = toggleLike(c.replies); if (found) return found; }
    }
    return null;
  };

  const updated = toggleLike(post.comments);
  if (!updated) return res.status(404).json({ error: 'Comment not found' });
  res.json(updated);
});

// ═════════════════════════════════════════════════════════════════════════════
// AI ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { prompt, maxTokens = 300, temperature = 0.7, topP = 0.9 } = req.body;
  if (!prompt)     return res.status(400).json({ error: 'No prompt provided' });
  if (!HF_API_KEY) return res.status(500).json({ error: 'HF_API_KEY not configured.' });

  try {
    const response = await fetch('https://router.huggingface.co/featherless-ai/v1/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'AstroMLab/AstroSage-8B', prompt, max_tokens: maxTokens, temperature, top_p: topP }),
    });
    if (!response.ok) throw new Error(`Chat API error: ${response.statusText}`);
    res.json(await response.json());
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/identify', async (req, res) => {
  if (!process.env.HF_TOKEN) {
    return res.json({ description: 'A celestial object with bright stellar regions.' });
  }
  try {
    const response = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.HF_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'moonshotai/Kimi-K2.5:novita',
        messages: [{
          role: 'user',
          content: [
            { type: 'text',      text: 'Describe this celestial object in one sentence.' },
            { type: 'image_url', image_url: { url: req.body.image } },
          ],
        }],
      }),
    });
    const result = await response.json();
    res.json({ description: result.choices?.[0]?.message?.content || 'Celestial structure' });
  } catch (e) {
    res.status(500).json({ error: 'Vision ID failed: ' + e.message });
  }
});

app.post('/api/analyze-discovery', async (req, res) => {
  console.log('🚀 Starting Discovery Pipeline...');
  try {
    const imageBuffer = Buffer.from(req.body.imageBase64, 'base64');

    const login   = await axios.post('http://nova.astrometry.net/api/login',
      `request-json=${JSON.stringify({ apikey: ASTROMETRY_API_KEY })}`);
    const session = login.data.session;

    const form = new FormData();
    form.append('request-json', JSON.stringify({ session, publicly_visible: 'n' }));
    form.append('file', imageBuffer, { filename: 'observation.jpg' });

    const up          = await axios.post('http://nova.astrometry.net/api/upload', form, { headers: form.getHeaders() });
    const calibration = await getCalibrationResults(up.data.subid);
    const nasaUrl     = `https://skyview.gsfc.nasa.gov/cgi-bin/images?survey=sdssi&position=${calibration.ra},${calibration.dec}&size=0.1&pixels=500`;
    const diffCount   = await performChangeDetection(imageBuffer, nasaUrl);
    const isAnomaly   = diffCount > 1500;

    res.json({
      coords:         { ra: calibration.ra.toFixed(4), dec: calibration.dec.toFixed(4) },
      historicalImage: nasaUrl,
      discovery:      isAnomaly ? `ANOMALY: Found ${diffCount} pixel variances.` : 'Region stable.',
      type:           isAnomaly ? 'SUPERNOVA' : 'GALAXY',
      rawScore:       diffCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TWITTER AUTH
// ═════════════════════════════════════════════════════════════════════════════
app.get('/auth/twitter/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect(`${FRONTEND_URL}?error=no_code`);

    const tokenResponse = await axios.post(
      'https://api.twitter.com/2/oauth2/token',
      new URLSearchParams({ code, grant_type: 'authorization_code', client_id: TWITTER_CLIENT_ID,
        redirect_uri: `${FRONTEND_URL}/auth/twitter/callback`, code_verifier: 'challenge' }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString('base64')}` } }
    );

    const { access_token } = tokenResponse.data;
    const userResponse     = await axios.get('https://api.twitter.com/2/users/me',
      { headers: { Authorization: `Bearer ${access_token}` } });
    const twitterUser      = userResponse.data.data;

    const userId   = `twitter-${twitterUser.id}`;
    const user     = getOrCreateUser(userId);
    user.username  = twitterUser.username;
    user.twitterId = twitterUser.id;
    user.method    = 'twitter';
    console.log(`✅ Twitter auth: ${user.username}`);

    const userData = encodeURIComponent(JSON.stringify({ id: userId, username: user.username, method: 'twitter', avatar: user.avatar }));
    res.redirect(`${FRONTEND_URL}?auth=success&user=${userData}`);
  } catch (err) {
    console.error('❌ Twitter OAuth error:', err.message);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

app.get('/auth/me', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId)           return res.status(401).json({ error: 'Not authenticated' });
  const user = userProfiles[userId];
  if (!user)             return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ═════════════════════════════════════════════════════════════════════════════
// ROOT
// ═════════════════════════════════════════════════════════════════════════════
app.get('/', (_req, res) => {
  res.json({
    message:  '🌌 AstroVision Discovery Backend',
    version:  '4.0.0',
    features: ['Supabase DAO', 'User Profiles', 'Twitter Auth', 'AI Analysis', 'Astrometry'],
    status: {
      supabase:       process.env.SUPABASE_URL ? '✓' : '✗',
      hf_api_key:     HF_API_KEY               ? '✓' : '✗',
      astrometry_key: ASTROMETRY_API_KEY        ? '✓' : '✗',
      twitter_oauth:  TWITTER_CLIENT_ID         ? '✓' : '✗',
    },
    dao_endpoints: [
      'GET  /api/dao/posts',
      'POST /api/dao/posts',
      'POST /api/dao/posts/:id/like',
      'GET  /api/dao/posts/:id/comments',
      'POST /api/dao/posts/:id/comments',
      'POST /api/dao/comments/:id/like',
    ],
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// START
// ═════════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🌌 AstroVision Backend v4.0`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🚀 Port: ${PORT}`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL       ? '✓ connected' : '✗ SUPABASE_URL missing'}`);
  console.log(`🤖 HF AI:    ${HF_API_KEY                      ? '✓ ready'     : '✗ HF_API_KEY missing'}`);
  console.log(`🔐 Twitter:  ${TWITTER_CLIENT_ID               ? '✓ enabled'   : '✗ disabled'}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});