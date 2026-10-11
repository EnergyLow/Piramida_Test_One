// supabase/functions/submit-review/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

interface ReviewPayload {
  name: string
  rating: number | string
  text: string
  honeypot?: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' })
  }

  try {
    const payload: ReviewPayload = await req.json()

    // Honeypot — если заполнено, это бот
    if (payload.honeypot && payload.honeypot.trim() !== '') {
      return jsonResponse(200, { ok: true, message: 'Спасибо за отзыв!' })
    }

    const name = (payload.name || '').trim()
    const text = (payload.text || '').trim()
    const rating = parseInt(String(payload.rating), 10)

    if (name.length < 2 || name.length > 60) {
      return jsonResponse(400, { ok: false, error: 'Имя должно быть от 2 до 60 символов.' })
    }
    if (!rating || rating < 1 || rating > 5) {
      return jsonResponse(400, { ok: false, error: 'Оценка должна быть от 1 до 5.' })
    }
    if (text.length < 10 || text.length > 2000) {
      return jsonResponse(400, { ok: false, error: 'Текст отзыва должен быть от 10 до 2000 символов.' })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data, error } = await supabase
      .from('reviews')
      .insert({ name, rating, review_text: text })
      .select()
      .single()

    if (error) {
      console.error('DB error:', error)
      return jsonResponse(500, { ok: false, error: 'Ошибка сохранения отзыва.' })
    }

    // Уведомление всем админам с inline-кнопкой «Удалить»
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')
    const chatIds = (Deno.env.get('TELEGRAM_CHAT_ID') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    if (botToken && chatIds.length) {
      const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating)
      const message = [
        '⭐ Новый отзыв опубликован на сайте «Пирамида»',
        '',
        `👤 Имя: ${data.name}`,
        `⭐ Оценка: ${stars}`,
        `💬 Текст: ${data.review_text}`,
        '',
        `🆔 Отзыв #${data.id}`,
      ].join('\n')

      for (const chatId of chatIds) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: message,
              reply_markup: {
                inline_keyboard: [[
                  { text: '🗑 Удалить отзыв', callback_data: `delete_review:${data.id}` },
                ]],
              },
            }),
          })
        } catch (tgErr) {
          console.error(`Telegram notify error to ${chatId}:`, tgErr)
        }
      }
    }

    return jsonResponse(201, { ok: true, message: 'Спасибо за отзыв!' })

  } catch (err) {
    console.error('Unexpected error:', err)
    return jsonResponse(500, { ok: false, error: 'Внутренняя ошибка.' })
  }
})

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}