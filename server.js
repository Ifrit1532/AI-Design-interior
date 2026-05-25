require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const FormData = require('form-data');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY
  });
});

// ─── Route 1: Image Redesign via OpenAI gpt-image-1 ──────────────────────────
app.post('/api/redesign', upload.single('image'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: 'OPENAI_API_KEY не задан в .env' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Изображение не загружено' });
    }

    const { description } = req.body;
    if (!description?.trim()) {
      return res.status(400).json({ error: 'Описание изменений обязательно' });
    }

    // Build a precise prompt for interior editing preserving geometry
    const systemPrompt = `You are an expert interior designer. Edit the uploaded interior photo according to the instructions below.
CRITICAL RULES:
- Preserve EXACTLY: room geometry, walls, windows, doors, ceiling height, floor plan, lighting positions, and all unchanged objects
- Only modify the specific elements mentioned in the instructions
- Maintain photorealistic quality and consistent lighting
- Keep proportions and perspective identical to the original photo
Instructions: ${description.trim()}`;

    const formData = new FormData();
    formData.append('model', 'gpt-image-1');
    formData.append('prompt', systemPrompt);
    formData.append('n', '1');
    formData.append('size', '1024x1024');
    formData.append('quality', 'high');
    formData.append(
      'image',
      req.file.buffer,
      { filename: 'interior.png', contentType: req.file.mimetype }
    );

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenAI error:', data);
      return res.status(response.status).json({
        error: data.error?.message || 'Ошибка OpenAI API'
      });
    }

    // Return base64 image
    const imageData = data.data[0].b64_json;
    res.json({
      success: true,
      image: `data:image/png;base64,${imageData}`,
      revised_prompt: data.data[0].revised_prompt || null
    });

  } catch (err) {
    console.error('Redesign error:', err);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
});

// ─── Route 2: Renovation Estimate via Anthropic Claude ────────────────────────
app.post('/api/estimate', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY не задан в .env' });
    }

    const { imageBase64, description, isRedesigned } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Изображение обязательно' });
    }

    // Extract base64 data from data URL
    const base64Data = imageBase64.includes(',')
      ? imageBase64.split(',')[1]
      : imageBase64;

    const mediaType = imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    const systemPrompt = `Ты — опытный прораб и сметчик с 20-летним стажем в России. 
Анализируй изображение интерьера и составляй детальные сметы ремонта.
Отвечай ТОЛЬКО в формате JSON без markdown-обёрток, строго следуя схеме.`;

    const userPrompt = `Проанализируй ${isRedesigned ? 'отредактированное изображение интерьера' : 'изображение интерьера'} и составь подробную смету ремонта.
${description ? `Желаемые изменения: ${description}` : ''}

Верни JSON строго по этой схеме (числа без разделителей тысяч, только цифры):
{
  "summary": "краткое описание объёма работ в 2-3 предложениях",
  "area_sqm": число (примерная площадь помещения в кв.м),
  "categories": [
    {
      "name": "название категории работ",
      "icon": "эмодзи-иконка",
      "items": [
        {
          "work": "название работы или материала",
          "unit": "единица измерения (м², м.п., шт, компл.)",
          "qty": число,
          "price_per_unit": число (цена за единицу в рублях),
          "total": число (итого по позиции в рублях)
        }
      ]
    }
  ],
  "total_works": число (итого работы),
  "total_materials": число (итого материалы),
  "grand_total": число (общий итог),
  "timeline_weeks": число (срок в неделях),
  "notes": ["важное примечание 1", "важное примечание 2"]
}

Категории должны включать: Демонтаж, Черновые работы, Чистовые работы, Электрика, Сантехника (если видна), Материалы и отделка, Мебель и декор (если нужна замена).
Цены — актуальные для Москвы 2024-2025 года.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64Data
                }
              },
              {
                type: 'text',
                text: userPrompt
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic error:', data);
      return res.status(response.status).json({
        error: data.error?.message || 'Ошибка Anthropic API'
      });
    }

    const rawText = data.content[0].text;

    // Parse JSON from response
    let estimate;
    try {
      // Strip possible markdown code fences
      const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      estimate = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr, 'Raw:', rawText);
      return res.status(500).json({
        error: 'Не удалось разобрать ответ модели. Попробуйте ещё раз.',
        raw: rawText
      });
    }

    res.json({ success: true, estimate });

  } catch (err) {
    console.error('Estimate error:', err);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
});

// ─── Catch-all: serve frontend ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🏠 Interior Redesign AI запущен на http://localhost:${PORT}`);
  console.log(`   OpenAI API:    ${process.env.OPENAI_API_KEY ? '✅ настроен' : '❌ не задан (добавьте в .env)'}`);
  console.log(`   Anthropic API: ${process.env.ANTHROPIC_API_KEY ? '✅ настроен' : '❌ не задан (добавьте в .env)'}\n`);
});
