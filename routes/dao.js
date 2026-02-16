// routes/dao.js
// All Supabase DAO operations — runs on your Express server only.
// Supabase credentials never reach the browser.

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');
const multer  = require('multer');

// ── Supabase client (server-side only) ────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service role key — NEVER sent to browser
);

// ── Image upload (memory storage → stream to Supabase) ────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
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
  rows.forEach(c => { map[c.id] = { ...c, replies: [], timeString: formatTimeString(c.created_at) }; });
  rows.forEach(c => {
    if (c.parent_id && map[c.parent_id]) map[c.parent_id].replies.push(map[c.id]);
    else roots.push(map[c.id]);
  });
  return roots;
};

// ── POST /api/dao/posts  — get all posts ──────────────────────────────────────
router.get('/posts', async (req, res) => {
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
    console.error('GET /posts error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/dao/posts  — create a post (with optional image) ────────────────
router.post('/posts', upload.single('image'), async (req, res) => {
  try {
    const { text, userId, author } = req.body;
    let imageUrl = null;

    // Upload image to Supabase Storage if provided
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
    console.error('POST /posts error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/dao/posts/:id/like  — toggle like ───────────────────────────────
router.post('/posts/:id/like', async (req, res) => {
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
    console.error('POST /posts/:id/like error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/dao/posts/:id/comments  — get comments ──────────────────────────
router.get('/posts/:id/comments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('comments')
      .select('*')
      .eq('post_id', req.params.id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ success: true, comments: buildNestedComments(data) });
  } catch (err) {
    console.error('GET /comments error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/dao/posts/:id/comments  — create comment ───────────────────────
router.post('/posts/:id/comments', async (req, res) => {
  try {
    const { userId, author, text, parentId = null } = req.body;

    const { data, error } = await supabase
      .from('comments')
      .insert([{
        post_id:   req.params.id,
        parent_id: parentId,
        user_id:   userId,
        author, text,
        likes: 0, liked_by: [],
      }])
      .select().single();

    if (error) throw error;
    res.json({ success: true, comment: data });
  } catch (err) {
    console.error('POST /comments error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/dao/comments/:id/like  — toggle comment like ───────────────────
router.post('/comments/:id/like', async (req, res) => {
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
    console.error('POST /comments/:id/like error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;