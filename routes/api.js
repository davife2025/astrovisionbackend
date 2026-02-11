// backend/routes/api.js

const express = require('express');
const router = express.Router();
require('dotenv').config();

const HF_API_KEY = process.env.HF_API_KEY;

/**
 * Identify celestial objects using Llava vision model
 */
router.post('/identify', async (req, res) => {
  const { image } = req.body;

  try {
    const response = await fetch(
      'https://api-inference.huggingface.co/models/llava-hf/llava-1.5-7b-hf',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: {
            image,
            text: 'Identify the astronomical object. Describe its visual structure in detail.',
          },
        }),
      }
    );

    if (response.status === 503) {
      return res.status(503).json({ error: 'Vision model is loading. Please try again in 30 seconds.' });
    }

    if (!response.ok) {
      throw new Error(`HF API error: ${response.statusText}`);
    }

    const result = await response.json();
    const description = result[0]?.generated_text || 'Celestial structure detected.';

    res.json({ description });
  } catch (error) {
    console.error('Llava identification error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Chat with AstroSage AI model
 */
router.post('/chat', async (req, res) => {
  const { prompt, maxTokens = 300, temperature = 0.7, topP = 0.9 } = req.body;

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

/**
 * Analyze discovery with scientific backend
 * (This should connect to your existing scientific analysis service)
 */
router.post('/analyze-discovery', async (req, res) => {
  const { imageBase64 } = req.body;

  try {
    // TODO: Replace with your actual scientific analysis logic
    // This is a placeholder that simulates the response structure

    // Example: Call your Python backend, astronomical database, etc.
    const analysisResult = {
      coords: {
        ra: '12h 34m 56.7s',
        dec: '+45° 12\' 34"',
      },
      discovery: 'Possible gravitational lensing detected',
      type: 'GALAXY',
      historicalImage: null, // Add NASA API integration here
      confidence: 0.87,
    };

    res.json(analysisResult);
  } catch (error) {
    console.error('Discovery analysis error:', error);
    res.status(500).json({ error: 'Scientific backend offline' });
  }
});

/**
 * Fetch NASA astronomical image
 */
router.get('/nasa-image', async (req, res) => {
  const { query } = req.query;
  const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

  try {
    const response = await fetch(
      `https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=image`,
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error('NASA API error');
    }

    const data = await response.json();
    const items = data.collection?.items || [];

    if (items.length > 0) {
      const imageUrl = items[0].links?.[0]?.href;
      res.json({ imageUrl });
    } else {
      res.json({ imageUrl: null });
    }
  } catch (error) {
    console.error('NASA API error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;