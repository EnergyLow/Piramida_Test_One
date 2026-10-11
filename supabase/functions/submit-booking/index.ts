// supabase/functions/submit-booking/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

interface BookingPayload {
  name: string
  phone: string
  date: string
  time: string
  guests: string
  comment?: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ ok: false, error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const payload: BookingPayload = await req.json()

    const name = (payload.name || '').trim()
    const phone = (payload.phone || '').trim()
    const date = (payload.date || '').trim()
    const time = (payload.time || '').trim()
    const guestsRaw = String(payload.guests || '')
    const comment = (payload.comment || '').trim()

    if (name.length < 2 || name.length > 80) {
      return jsonResponse(400, { ok: false, error: 'Укажите имя (от 2 до 80 символов).' })
    }

    const digits = phone.replace(/\D/g, '')
    if (digits.length < 10 || digits.length > 15) {
      return jsonResponse(400, { ok: false, error: 'Укажите корректный телефон.' })
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResponse(400, { ok: false, error: 'Некорректная дата.' })
    }

    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return jsonResponse(400, { ok: false, error: 'Некорректное время.' })
    }

    let guestsNum = 0
    let guestsLabel = ''
    if (guestsRaw === '7+') {
      guestsNum = 7
      guestsLabel = '7 и более'
    } else {
      guestsNum = parseInt(guestsRaw, 10)
      if (!guestsNum || guestsNum < 1 || guestsNum > 6) {
        return jsonResponse(400, { ok: false, error: 'Выберите количество гостей.' })
      }
      guestsLabel = String(guestsNum)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data, error } = await supabase
      .from('bookings')
      .insert({
        name,
        phone,
        booking_date: date,
        booking_time: time,
        guests: guestsNum,
        comment: comment || null,
        status: 'pending',
      })
      .select()
      .single()

    if (error) {
      console.error('DB error:', error)
      return jsonResponse(500, { ok: false, error: 'Не удалось сохранить заявку.' })
    }

    // Уведомление всем админам
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')
    const chatIds = (Deno.env.get('TELEGRAM_CHAT_ID') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    if (botToken && chatIds.length) {
      const message = [
        '🔔 Новая заявка на бронирование — «Пирамида»',
        '',
        `Номер заявки: #${data.id}`,
        `👤 Имя: ${data.name}`,
        `📞 Телефон: ${data.phone}`,
        `📅 Дата: ${formatDate(data.booking_date)}`,
        `🕒 Время: ${data.booking_time}`,
        `👥 Гостей: ${guestsLabel}`,
        `💬 Комментарий: ${data.comment || 'Не указан'}`,
        '',
        'Статус: ⏳ Ожидает подтверждения',
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
                  { text: '✅ Подтвердить', callback_data: `confirm:${data.id}` },
                  { text: '❌ Отклонить',   callback_data: `reject:${data.id}` },
                ]],
              },
            }),
          })
        } catch (tgErr) {
          console.error(`Telegram notify error to ${chatId}:`, tgErr)
        }
      }
    }

    return jsonResponse(201, {
      ok: true,
      bookingNumber: data.id,
      message: 'Заявка отправлена! Администратор свяжется с вами для подтверждения.',
    })

  } catch (err) {
    console.error('Unexpected error:', err)
    return jsonResponse(500, { ok: false, error: 'Внутренняя ошибка сервера.' })
  }
})

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}