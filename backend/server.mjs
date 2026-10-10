import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error(
    'Не заданы SUPABASE_URL и SUPABASE_SECRET_KEY в .env'
  );
}

const supabase = createClient(supabaseUrl, supabaseSecretKey);

const ADMIN_CHAT_IDS = [
  ...new Set(
    (
      process.env.ADMIN_CHAT_IDS ||
      process.env.ADMIN_CHAT_ID ||
      ''
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  ),
];

const ADMIN_CHAT_ID_SET = new Set(ADMIN_CHAT_IDS);

const POLL_TIMEOUT = Math.min(
  50,
  Math.max(
    1,
    Number.parseInt(process.env.TELEGRAM_POLL_TIMEOUT || '25', 10)
  )
);

const ALLOWED_ORIGINS = new Set(
  (
    process.env.ALLOWED_ORIGINS ||
    'http://127.0.0.1:5500,http://localhost:5500'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '12kb', strict: true }));

let writeQueue = Promise.resolve();
let polling = false;
let updateOffset = 0;

const rateBuckets = new Map();
const reviewRateBuckets = new Map();
const reviewCooldowns = new Map();

const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_REVIEW_REQUESTS = 5;
const REVIEW_COOLDOWN_MS = 15 * 60 * 1000;

// --------------------------------------------------
// Общие функции
// --------------------------------------------------

function safeEqual(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.length > 0 &&
    a === b
  );
}

function cleanText(value, max) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim()
        .slice(0, max)
    : '';
}

function corsAndOrigin(req, res, next) {
  const origin = req.get('origin');

  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({
        ok: false,
        error: 'Источник запроса не разрешён.',
      });
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
}

app.use(corsAndOrigin);

app.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';

  let bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    bucket = { count: 0, start: now };
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (rateBuckets.size > 5000) {
    for (const [ip, entry] of rateBuckets) {
      if (now - entry.start > RATE_WINDOW_MS) {
        rateBuckets.delete(ip);
      }
    }
  }

  if (bucket.count > 15 && req.path === '/api/bookings') {
    return res.status(429).json({
      ok: false,
      error: 'Слишком много попыток. Попробуйте позже или позвоните нам.',
    });
  }

  next();
});

function serialWrite(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => {});
  return next;
}

async function readJsonArray(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function persistJsonArray(file, items) {
  await mkdir(DATA_DIR, { recursive: true });

  const temp = `${file}.tmp`;

  await writeFile(
    temp,
    `${JSON.stringify(items, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );

  await rename(temp, file);
}

function formatDate(date) {
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

function statusLabel(status) {
  return status === 'confirmed'
    ? '✅ Подтверждена'
    : status === 'rejected'
      ? '❌ Отклонена'
      : status === 'notification_failed'
        ? '⚠️ Ошибка уведомления администратору'
        : '⏳ Ожидает подтверждения';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// --------------------------------------------------
// Бронирования: локальный файл
// --------------------------------------------------

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  const parsed = new Date(`${date}T00:00:00.000Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    return false;
  }

  const now = new Date();

  const today =
    `${now.getFullYear()}-` +
    `${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}`;

  return date >= today;
}

function validateBooking(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Проверьте данные формы.' };
  }

  const name = cleanText(body.name, 80);
  const phone = cleanText(body.phone, 32);
  const date = cleanText(body.date, 10);
  const time = cleanText(body.time, 5);
  const guests = cleanText(String(body.guests ?? ''), 3);
  const comment = cleanText(body.comment, 500);

  const digits = phone.replace(/\D/g, '');

  if (name.length < 2) {
    return { error: 'Укажите имя (не менее двух символов).' };
  }

  if (
    digits.length < 10 ||
    digits.length > 15 ||
    !/^[+\d\s().-]+$/.test(phone)
  ) {
    return {
      error: 'Укажите корректный номер телефона с кодом страны.',
    };
  }

  if (!validDate(date)) {
    return { error: 'Выберите корректную дату не в прошлом.' };
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return { error: 'Выберите корректное время.' };
  }

  if (!/^(?:[1-9]|[1-9]\d|100|7\+)$/.test(guests)) {
    return { error: 'Укажите корректное количество гостей.' };
  }

  if (body.consent !== true) {
    return {
      error: 'Необходимо согласие на обработку персональных данных.',
    };
  }

  return {
    value: { name, phone, date, time, guests, comment },
  };
}

async function readBookings() {
  return readJsonArray(BOOKINGS_FILE);
}

async function persistBookings(bookings) {
  return persistJsonArray(BOOKINGS_FILE, bookings);
}

async function mutateBookings(mutator) {
  return serialWrite(async () => {
    const bookings = await readBookings();
    const result = await mutator(bookings);
    await persistBookings(bookings);
    return result;
  });
}

// --------------------------------------------------
// Telegram API
// --------------------------------------------------

async function telegramApi(method, payload, timeoutMs = 15000) {
  if (!BOT_TOKEN) {
    throw new Error('Telegram не настроен.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );

    const result = await response.json().catch(() => null);

    if (!response.ok || !result?.ok) {
      const error = new Error(
        `Telegram API returned ${response.status || 'an error'}`
      );

      error.telegramDescription = cleanText(
        result?.description || 'Telegram API отклонил запрос.',
        200
      );

      throw error;
    }

    return result.result;
  } finally {
    clearTimeout(timer);
  }
}

function bookingMessage(booking) {
  return [
    '🔔 <b>Новая заявка на бронирование — «Пирамида»</b>',
    '',
    `Номер заявки: <b>#${booking.number}</b>`,
    `👤 Имя: ${escapeHtml(booking.name)}`,
    `📞 Телефон: ${escapeHtml(booking.phone)}`,
    `📅 Дата: ${formatDate(booking.date)}`,
    `🕒 Время: ${booking.time}`,
    `👥 Гостей: ${booking.guests === '7+' ? '7 и более' : booking.guests}`,
    `💬 Комментарий: ${escapeHtml(booking.comment || 'Не указан')}`,
    '',
    `Статус: ${statusLabel(booking.status)}`,
  ].join('\n');
}

function bookingKeyboard(booking) {
  return {
    inline_keyboard: [
      [
        {
          text: '✅ Подтвердить',
          callback_data: `confirm:${booking.id}`,
        },
        {
          text: '❌ Отклонить',
          callback_data: `reject:${booking.id}`,
        },
      ],
    ],
  };
}

// --------------------------------------------------
// Проверка работы сервера
// --------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'piramida-booking',
    telegramConfigured: Boolean(BOT_TOKEN && ADMIN_CHAT_IDS.length),
  });
});

// --------------------------------------------------
// Создание бронирования
// Сохраняем в Supabase и отправляем в Telegram
// --------------------------------------------------

app.post('/api/bookings', async (req, res) => {
  if (!BOT_TOKEN || !ADMIN_CHAT_IDS.length) {
    return res.status(503).json({
      ok: false,
      error:
        'Онлайн-бронирование пока не настроено. Позвоните: +7 (959) 505-10-25.',
    });
  }

  const validation = validateBooking(req.body);

  if (validation.error) {
    return res.status(400).json({
      ok: false,
      error: validation.error,
    });
  }

  try {
    // Сначала сохраняем заявку в локальный файл.
    const booking = await mutateBookings(async (bookings) => {
      const number =
        bookings.reduce(
          (max, item) => Math.max(max, Number(item.number) || 0),
          0
        ) + 1;

      const item = {
        id: randomUUID(),
        number,
        ...validation.value,
        status: 'pending',
        statusLabel: 'Ожидает подтверждения',
        createdAt: new Date().toISOString(),
        telegramMessageId: null,
        telegramChatId: ADMIN_CHAT_IDS[0],
        telegramMessages: [],
        notificationError: null,
      };

      bookings.push(item);
      return item;
    });

    // Затем сохраняем заявку в Supabase.
    const { error: supabaseError } = await supabase
      .from('bookings')
      .insert({
        name: booking.name,
        phone: booking.phone,
        booking_date: booking.date,
        booking_time: booking.time,
        guests: booking.guests,
        comment: booking.comment,
        status: booking.status,
      });

    if (supabaseError) {
      console.error(
        'Ошибка сохранения заявки в Supabase:',
        supabaseError.message
      );

      return res.status(500).json({
        ok: false,
        error:
          'Не удалось сохранить заявку. Пожалуйста, попробуйте позже или позвоните в заведение.',
      });
    }

    // Отправляем уведомление каждому администратору.
    const sentMessages = [];
    const notificationFailures = [];

    for (const chatId of ADMIN_CHAT_IDS) {
      try {
        const message = await telegramApi('sendMessage', {
          chat_id: chatId,
          text: bookingMessage(booking),
          parse_mode: 'HTML',
          reply_markup: bookingKeyboard(booking),
        });

        sentMessages.push({
          chatId: String(message.chat.id),
          messageId: message.message_id,
        });
      } catch (error) {
        const reason =
          error.telegramDescription ||
          error.message ||
          'Неизвестная ошибка Telegram';

        notificationFailures.push({ chatId, reason });

        console.error(
          `Не удалось отправить заявку #${booking.number} администратору ${chatId}: ${reason}`
        );
      }
    }

    if (sentMessages.length > 0) {
      await mutateBookings(async (bookings) => {
        const item = bookings.find((entry) => entry.id === booking.id);

        if (item) {
          item.telegramMessages = sentMessages;
          item.telegramMessageId = sentMessages[0]?.messageId ?? null;
          item.telegramChatId = sentMessages[0]?.chatId ?? null;
          item.notifiedAt = new Date().toISOString();
          item.notificationFailures = notificationFailures;

          item.notificationError = notificationFailures.length
            ? 'Не всем администраторам удалось доставить уведомление. Проверьте Telegram ID и доступ к боту.'
            : null;
        }
      });
    } else {
      const reason = notificationFailures
        .map((failure) => `${failure.chatId}: ${failure.reason}`)
        .join('; ');

      await mutateBookings(async (bookings) => {
        const item = bookings.find((entry) => entry.id === booking.id);

        if (item) {
          item.status = 'notification_failed';
          item.statusLabel = 'Ошибка отправки уведомления';
          item.notificationError = reason || 'Telegram API недоступен';
        }
      }).catch(() => {});

      // Обновляем статус заявки и в Supabase.
      const { error: statusError } = await supabase
        .from('bookings')
        .update({ status: 'notification_failed' })
        .eq('name', booking.name)
        .eq('phone', booking.phone)
        .eq('booking_date', booking.date)
        .eq('booking_time', booking.time)
        .eq('status', 'pending');

      if (statusError) {
        console.error(
          'Не удалось обновить статус заявки в Supabase:',
          statusError.message
        );
      }

      return res.status(502).json({
        ok: false,
        error:
          'Не удалось отправить заявку ни одному администратору. Проверьте Telegram ID и попросите каждого администратора нажать Start у бота.',
      });
    }

    return res.status(201).json({
      ok: true,
      bookingNumber: booking.number,
      message:
        'Заявка отправлена! Администратор свяжется с вами для подтверждения бронирования. Это ещё не подтверждение столика.',
    });
  } catch (error) {
    console.error(
      'Не удалось сохранить заявку на бронирование:',
      error.message || error
    );

    return res.status(500).json({
      ok: false,
      error:
        'Не удалось сохранить заявку. Попробуйте ещё раз или позвоните в заведение.',
    });
  }
});

// --------------------------------------------------
// Отзывы: локальный JSON-файл
// --------------------------------------------------

async function readReviews() {
  return readJsonArray(REVIEWS_FILE);
}

async function persistReviews(reviews) {
  return persistJsonArray(REVIEWS_FILE, reviews);
}

async function mutateReviews(mutator) {
  return serialWrite(async () => {
    const reviews = await readReviews();
    const result = await mutator(reviews);
    await persistReviews(reviews);
    return result;
  });
}

function validateReview(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Проверьте данные формы.' };
  }

  // Поле-ловушка должно оставаться пустым.
  if (cleanText(body.website, 200)) {
    return { error: 'Не удалось отправить отзыв.' };
  }

  const name = cleanText(body.name, 60);
  const text = cleanText(body.text, 1200);
  const rating = Number(body.rating);

  if (name.length < 2) {
    return { error: 'Имя должно содержать не менее 2 символов.' };
  }

  if (text.length < 10) {
    return { error: 'Отзыв должен содержать не менее 10 символов.' };
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { error: 'Выберите оценку от 1 до 5.' };
  }

  if (body.consent !== true) {
    return { error: 'Подтвердите согласие на публикацию отзыва.' };
  }

  return {
    value: { name, text, rating },
  };
}

app.get('/api/reviews', async (_req, res) => {
  try {
    const reviews = await readReviews();

    reviews.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() -
        new Date(a.createdAt).getTime()
    );

    const count = reviews.length;
    const average = count
      ? reviews.reduce((sum, review) => sum + review.rating, 0) / count
      : 0;

    return res.json({
      ok: true,
      reviews,
      count,
      average: Number(average.toFixed(2)),
    });
  } catch (error) {
    console.error('Не удалось загрузить отзывы:', error.message || error);

    return res.status(500).json({
      ok: false,
      error: 'Не удалось загрузить отзывы. Попробуйте позже.',
    });
  }
});

function reviewRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const lastReviewAt = reviewCooldowns.get(ip);

  if (lastReviewAt && now - lastReviewAt < REVIEW_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil(
      (REVIEW_COOLDOWN_MS - (now - lastReviewAt)) / 1000
    );

    return res.status(429).json({
      ok: false,
      error: `Следующий отзыв можно отправить через ${Math.ceil(retryAfterSeconds / 60)} мин.`,
      retryAfterSeconds,
    });
  }

  reviewCooldowns.set(ip, now);

  res.on('finish', () => {
    if (res.statusCode >= 400 && reviewCooldowns.get(ip) === now) {
      reviewCooldowns.delete(ip);
    }
  });

  next();
}

app.post('/api/reviews', reviewRateLimit, async (req, res) => {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';

  let bucket = reviewRateBuckets.get(key);

  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    bucket = { count: 0, start: now };
  }

  bucket.count += 1;
  reviewRateBuckets.set(key, bucket);

  if (reviewRateBuckets.size > 5000) {
    for (const [ip, entry] of reviewRateBuckets) {
      if (now - entry.start >= RATE_WINDOW_MS) {
        reviewRateBuckets.delete(ip);
      }
    }
  }

  if (bucket.count > MAX_REVIEW_REQUESTS) {
    return res.status(429).json({
      ok: false,
      error: 'Слишком много отзывов за короткое время. Попробуйте позже.',
    });
  }

  const validation = validateReview(req.body);

  if (validation.error) {
    return res.status(400).json({
      ok: false,
      error: validation.error,
    });
  }

  try {
    const review = await mutateReviews(async (reviews) => {
      const item = {
        id: randomUUID(),
        ...validation.value,
        createdAt: new Date().toISOString(),
      };

      reviews.push(item);
      return item;
    });

    return res.status(201).json({
      ok: true,
      review,
      message: 'Спасибо! Ваш отзыв опубликован.',
    });
  } catch (error) {
    console.error('Не удалось сохранить отзыв:', error.message || error);

    return res.status(500).json({
      ok: false,
      error: 'Не удалось сохранить отзыв. Попробуйте позже.',
    });
  }
});

// --------------------------------------------------
// Telegram: кнопки подтверждения и отклонения
// --------------------------------------------------

async function handleCallback(callback) {
  const callbackId = callback.id;
  const actorId = String(callback.from?.id ?? '');
  const chatId = String(callback.message?.chat?.id ?? '');
  const data = typeof callback.data === 'string' ? callback.data : '';

  if (!ADMIN_CHAT_ID_SET.has(actorId) || !safeEqual(chatId, actorId)) {
    await telegramApi('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: 'Это действие доступно только администратору.',
      show_alert: true,
    });

    return;
  }

  const match = /^(confirm|reject):([0-9a-f-]{36})$/.exec(data);

  if (!match) {
    await telegramApi('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: 'Некорректное действие.',
    });

    return;
  }

  const [, action, id] = match;

  const outcome = await mutateBookings(async (bookings) => {
    const booking = bookings.find((item) => item.id === id);

    if (!booking) return { kind: 'missing' };

    if (booking.status !== 'pending') {
      return { kind: 'closed', booking };
    }

    booking.status = action === 'confirm' ? 'confirmed' : 'rejected';
    booking.statusLabel =
      action === 'confirm' ? 'Подтверждена' : 'Отклонена';
    booking.updatedAt = new Date().toISOString();

    return { kind: 'updated', booking };
  });

  if (outcome.kind === 'missing') {
    await telegramApi('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: 'Заявка не найдена.',
      show_alert: true,
    });

    return;
  }

  if (outcome.kind === 'closed') {
    await telegramApi('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: `Заявка уже обработана: ${statusLabel(outcome.booking.status)}`,
      show_alert: true,
    });

    return;
  }

  const booking = outcome.booking;

  // Синхронизируем статус с Supabase.
  // Важно: без отдельного ID строки Supabase используем поля заявки.
  // Если в таблице есть дубли с одинаковыми данными, обновиться могут несколько строк.
  const { error: supabaseError } = await supabase
    .from('bookings')
    .update({ status: booking.status })
    .eq('name', booking.name)
    .eq('phone', booking.phone)
    .eq('booking_date', booking.date)
    .eq('booking_time', booking.time)
    .eq('status', 'pending');

  if (supabaseError) {
    console.error(
      'Не удалось обновить статус в Supabase:',
      supabaseError.message
    );
  }

  try {
    const messages =
      Array.isArray(booking.telegramMessages) &&
      booking.telegramMessages.length
        ? booking.telegramMessages
        : booking.telegramMessageId && booking.telegramChatId
          ? [
              {
                chatId: booking.telegramChatId,
                messageId: booking.telegramMessageId,
              },
            ]
          : [];

    for (const message of messages) {
      try {
        await telegramApi('editMessageText', {
          chat_id: message.chatId,
          message_id: message.messageId,
          text: bookingMessage(booking),
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] },
        });
      } catch (error) {
        console.error(
          `Не удалось обновить копию заявки #${booking.number}: ${
            error.telegramDescription ||
            error.message ||
            'ошибка Telegram API'
          }`
        );
      }
    }

    await telegramApi('answerCallbackQuery', {
      callback_query_id: callbackId,
      text:
        action === 'confirm'
          ? 'Заявка подтверждена.'
          : 'Заявка отклонена.',
    });
  } catch (error) {
    try {
      await telegramApi('answerCallbackQuery', {
        callback_query_id: callbackId,
        text:
          'Статус сохранён, но сообщение не удалось обновить. Проверьте сервер.',
        show_alert: true,
      });
    } catch {}

    console.error(
      'Не удалось обновить сообщение Telegram:',
      error.message || error
    );
  }
}

// --------------------------------------------------
// Обработка ошибок
// --------------------------------------------------

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'Слишком большой запрос.',
    });
  }

  if (
    error instanceof SyntaxError &&
    Object.hasOwn(error, 'body')
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Некорректный JSON в запросе.',
    });
  }

  console.error('Необработанная ошибка API:', error.message || error);

  return res.status(500).json({
    ok: false,
    error: 'Внутренняя ошибка сервера.',
  });
});

// --------------------------------------------------
// Запуск Telegram long polling
// --------------------------------------------------

async function startTelegramPolling() {
  if (!BOT_TOKEN || !ADMIN_CHAT_IDS.length) {
    console.warn(
      'Telegram не настроен: заполните BOT_TOKEN и ADMIN_CHAT_IDS в backend/.env.'
    );

    return;
  }

  const invalidAdminIds = ADMIN_CHAT_IDS.filter(
    (id) => !/^-?\d+$/.test(id)
  );

  if (invalidAdminIds.length) {
    throw new Error(
      'ADMIN_CHAT_IDS должен содержать только числовые Telegram chat ID через запятую.'
    );
  }

  try {
    const webhook = await telegramApi('getWebhookInfo', {});

    if (webhook?.url) {
      throw new Error(
        'У бота уже настроен webhook. Отключите его перед запуском long polling.'
      );
    }

    const me = await telegramApi('getMe', {});

    console.log(
      `Telegram bot подключён: @${me.username || 'unknown'}. Long polling активен.`
    );
  } catch (error) {
    if (error.message.includes('webhook')) throw error;

    console.error(
      'Не удалось проверить Telegram API:',
      error.telegramDescription || error.message || error
    );

    return;
  }

  polling = true;

  pollLoop().catch((error) => {
    polling = false;

    console.error(
      'Long polling остановлен:',
      error.message || error
    );
  });
}

async function pollLoop() {
  while (polling) {
    try {
      const updates = await telegramApi(
        'getUpdates',
        {
          offset: updateOffset,
          timeout: POLL_TIMEOUT,
          allowed_updates: ['callback_query'],
        },
        (POLL_TIMEOUT + 10) * 1000
      );

      for (const update of updates) {
        updateOffset = Math.max(updateOffset, update.update_id + 1);

        if (update.callback_query) {
          try {
            await handleCallback(update.callback_query);
          } catch (error) {
            console.error(
              'Не удалось обработать действие Telegram:',
              error.message || error
            );
          }
        }
      }
    } catch (error) {
      if (error.telegramDescription?.includes('Conflict')) {
        console.error(
          'Конфликт getUpdates: возможно, уже запущен другой экземпляр бота.'
        );

        polling = false;
        return;
      }

      console.error(
        'Ошибка получения обновлений Telegram:',
        error.telegramDescription || error.message || error
      );

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// --------------------------------------------------
// Запуск сервера и корректное завершение
// --------------------------------------------------

await mkdir(DATA_DIR, { recursive: true });

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Piramida booking API слушает http://localhost:${PORT}`);

  startTelegramPolling().catch((error) => {
    console.error(
      error.message || 'Не удалось запустить Telegram polling.'
    );

    server.close(() => process.exit(1));
  });
});

async function shutdown() {
  polling = false;
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);