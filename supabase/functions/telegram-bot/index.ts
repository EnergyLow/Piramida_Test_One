// supabase/functions/telegram-bot/index.ts
import { Bot, webhookCallback } from 'npm:grammy@^1'
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is unset')

const bot = new Bot(token)

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// ===== Команды =====

bot.command('start', (ctx) => {
  ctx.reply(
    '🎤 Бот караоке-бара «Пирамида»\n\n' +
    '📋 /bookings — последние 10 заявок\n' +
    '📊 /stats — статистика заявок\n' +
    '⭐ /reviews — последние отзывы\n' +
    '🗑 /delete_review <id> — удалить отзыв'
  )
})

bot.command('bookings', async (ctx) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10)

  if (error || !data?.length) {
    return ctx.reply('Заявок пока нет 📭')
  }

  const text = data.map((b) => {
    const status = b.status === 'pending'
      ? '⏳'
      : b.status === 'confirmed'
        ? '✅'
        : '❌'
    return [
      `${status} #${b.id} — ${b.name}`,
      `📞 ${b.phone}`,
      `📅 ${b.booking_date} ${b.booking_time || ''}`,
      `👥 Гостей: ${b.guests}`,
    ].join('\n')
  }).join('\n\n')

  ctx.reply(text)
})

bot.command('stats', async (ctx) => {
  const { count: total } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })

  const { count: pending } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending')

  const { count: confirmed } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'confirmed')

  ctx.reply(
    `📊 Статистика заявок\n\n` +
    `📋 Всего: ${total ?? 0}\n` +
    `⏳ Ожидают: ${pending ?? 0}\n` +
    `✅ Подтверждено: ${confirmed ?? 0}`
  )
})

bot.command('reviews', async (ctx) => {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10)

  if (error || !data?.length) {
    return ctx.reply('Отзывов пока нет 📭')
  }

  const text = data.map((r) => {
    const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating)
    return [
      `⭐ #${r.id} — ${r.name}`,
      `${stars}`,
      `💬 ${r.review_text}`,
      `Удалить: /delete_review ${r.id}`,
    ].join('\n')
  }).join('\n\n')

  ctx.reply(text)
})

// Удаление отзыва командой (принимает <5>, #5, 5, "5abc")
bot.command('delete_review', async (ctx) => {
  const input = (ctx.match || '').trim()
  if (!input) return ctx.reply('Использование: /delete_review <id>')

  const id = parseInt(input.replace(/[^\d]/g, ''), 10)
  if (!id || isNaN(id)) {
    return ctx.reply('Укажи числовой ID отзыва (например: /delete_review 5)')
  }

  const { data, error } = await supabase
    .from('reviews')
    .delete()
    .eq('id', id)
    .select()
    .single()

  if (error || !data) {
    return ctx.reply(`Ошибка: ${error?.message || 'отзыв не найден'}`)
  }

  ctx.reply(`🗑 Отзыв от ${data.name} удалён`)
})

// ===== Inline-кнопки для заявок =====

bot.callbackQuery(/^confirm:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match![1], 10)

  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'confirmed' })
    .eq('id', id)
    .select()
    .single()

  if (error || !data) {
    return ctx.answerCallbackQuery({
      text: 'Ошибка: заявка не найдена',
      show_alert: true,
    })
  }

  ctx.answerCallbackQuery({ text: `Заявка #${id} подтверждена` })

  try {
    await ctx.editMessageText(
      `🔔 Заявка #${data.id} — подтверждена ✅\n\n` +
      `👤 ${data.name}\n` +
      `📞 ${data.phone}\n` +
      `📅 ${data.booking_date} в ${data.booking_time}\n` +
      `👥 Гостей: ${data.guests}`
    )
  } catch (e) {
    console.error('Edit message error:', e)
  }
})

bot.callbackQuery(/^reject:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match![1], 10)

  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .select()
    .single()

  if (error || !data) {
    return ctx.answerCallbackQuery({
      text: 'Ошибка: заявка не найдена',
      show_alert: true,
    })
  }

  ctx.answerCallbackQuery({ text: `Заявка #${id} отклонена` })

  try {
    await ctx.editMessageText(
      `🔔 Заявка #${data.id} — отклонена ❌\n\n` +
      `👤 ${data.name}\n` +
      `📞 ${data.phone}\n` +
      `📅 ${data.booking_date} в ${data.booking_time}`
    )
  } catch (e) {
    console.error('Edit message error:', e)
  }
})

// ===== Inline-кнопка «Удалить отзыв» =====

bot.callbackQuery(/^delete_review:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match![1], 10)

  const { data, error } = await supabase
    .from('reviews')
    .delete()
    .eq('id', id)
    .select()
    .single()

  if (error || !data) {
    return ctx.answerCallbackQuery({
      text: 'Ошибка: отзыв не найден',
      show_alert: true,
    })
  }

  await ctx.answerCallbackQuery({ text: `Отзыв от ${data.name} удалён` })

  try {
    await ctx.editMessageText(
      `🗑 Отзыв #${id} удалён\n\n` +
      `👤 ${data.name}\n` +
      `💬 ${data.review_text}`
    )
  } catch (e) {
    console.error('Edit message error:', e)
  }
})

// ===== Webhook =====

const handleUpdate = webhookCallback(bot, 'std/http')

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (secret !== token) {
    return new Response('Forbidden', { status: 403 })
  }

  try {
    return await handleUpdate(req)
  } catch (err) {
    console.error('Bot error:', err)
    return new Response('Error', { status: 500 })
  }
})