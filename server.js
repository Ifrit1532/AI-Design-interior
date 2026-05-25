require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const FormData = require('form-data');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────
function requireKey(res) {
  if (!process.env.OPENAI_API_KEY) {
    res.status(400).json({ error: 'OPENAI_API_KEY не задан в .env' });
    return false;
  }
  return true;
}

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', openai: !!process.env.OPENAI_API_KEY });
});

// ─── Route 1: Image Redesign — OpenAI gpt-image-1 ─────────────────────────────
app.post('/api/redesign', upload.single('image'), async (req, res) => {
  try {
    if (!requireKey(res)) return;
    if (!req.file)             return res.status(400).json({ error: 'Изображение не загружено' });

    const { description } = req.body;
    if (!description?.trim()) return res.status(400).json({ error: 'Описание изменений обязательно' });

    const prompt =
      `You are an expert interior designer. Edit the uploaded interior photo.\n` +
      `CRITICAL RULES:\n` +
      `- Preserve EXACTLY: room geometry, walls, windows, doors, ceiling height, floor plan, lighting positions, and all unchanged objects\n` +
      `- Only modify the specific elements mentioned below\n` +
      `- Maintain photorealistic quality and consistent lighting\n` +
      `- Keep proportions and perspective identical to the original photo\n` +
      `Instructions: ${description.trim()}`;

    const formData = new FormData();
    formData.append('model', 'gpt-image-1');
    formData.append('prompt', prompt);
    formData.append('n', '1');
    formData.append('size', '1024x1024');
    formData.append('quality', 'high');
    formData.append('image', req.file.buffer, { filename: 'interior.png', contentType: req.file.mimetype });

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...formData.getHeaders() },
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('OpenAI /images/edits error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'Ошибка OpenAI API' });
    }

    res.json({
      success: true,
      image: `data:image/png;base64,${data.data[0].b64_json}`,
      revised_prompt: data.data[0].revised_prompt || null
    });

  } catch (err) {
    console.error('Redesign error:', err);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
});

// ─── Route 2: Renovation Estimate — OpenAI gpt-4o (vision) ────────────────────
app.post('/api/estimate', async (req, res) => {
  try {
    if (!requireKey(res)) return;

    const { imageBase64, description, isRedesigned } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Изображение обязательно' });

    // gpt-4o accepts data-URL directly in image_url
    const imageUrl = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

    const userPrompt =
      `Проанализируй ${isRedesigned ? 'отредактированное изображение интерьера' : 'изображение интерьера'} и составь подробную смету ремонта.\n` +
      (description ? `Желаемые изменения: ${description}\n` : '') +
      `\nВерни ТОЛЬКО валидный JSON без markdown-обёрток, строго по схеме (все числа без разделителей, только цифры):\n` +
      `{\n` +
      `  "summary": "краткое описание объёма работ (2-3 предложения)",\n` +
      `  "area_sqm": <число>,\n` +
      `  "categories": [\n` +
      `    {\n` +
      `      "name": "название категории",\n` +
      `      "icon": "эмодзи",\n` +
      `      "items": [\n` +
      `        { "work": "...", "unit": "м²|м.п.|шт|компл.", "qty": <число>, "price_per_unit": <число>, "total": <число> }\n` +
      `      ]\n` +
      `    }\n` +
      `  ],\n` +
      `  "total_works": <число>,\n` +
      `  "total_materials": <число>,\n` +
      `  "grand_total": <число>,\n` +
      `  "timeline_weeks": <число>,\n` +
      `  "notes": ["примечание 1", "примечание 2"]\n` +
      `}\n` +
      `Категории: Демонтаж, Черновые работы, Чистовые работы, Электрика, Сантехника (если видна), Материалы и отделка, Мебель и декор.\n` +
      `Цены — актуальные для Москвы 2025 года.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4096,
        temperature: 0.3,
        response_format: { type: 'json_object' },   // ← гарантирует чистый JSON
        messages: [
          {
            role: 'system',
            content: 'Ты — опытный прораб и сметчик с 20-летним стажем в России. Отвечай ТОЛЬКО валидным JSON согласно схеме пользователя.'
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
              { type: 'text', text: userPrompt }
            ]
          }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('OpenAI /chat/completions error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'Ошибка OpenAI API' });
    }

    const rawText = data.choices[0].message.content;

    let estimate;
    try {
      const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      estimate = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr, '\nRaw:', rawText);
      return res.status(500).json({ error: 'Не удалось разобрать ответ модели. Попробуйте ещё раз.', raw: rawText });
    }

    res.json({ success: true, estimate });

  } catch (err) {
    console.error('Estimate error:', err);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
});

// ─── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🏠 Interior Redesign AI → http://localhost:${PORT}`);
  console.log(`   OpenAI API: ${process.env.OPENAI_API_KEY ? '✅ настроен' : '❌ не задан (добавьте в .env)'}\n`);
});
