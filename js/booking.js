
const CONFIG = window.PIRAMIDA_CONFIG || {};
const DEFAULT_ENDPOINT = "https://btyejqlyvoajcdufpesf.supabase.co/functions/v1/submit-booking";

export function initBooking() {
  const form = document.querySelector("#booking-form");
  const message = document.querySelector("#booking-message");
  const dateInput = document.querySelector("#booking-date");

  if (!form || !message || !dateInput) {
    console.error("Не найдены форма, сообщение или поле даты бронирования.");
    return;
  }

  function getToday() {
    const now = new Date();
    return new Date(
      now.getTime() - now.getTimezoneOffset() * 60000
    ).toISOString().slice(0, 10);
  }

  dateInput.min = getToday();

  function showMessage(text, type = "info") {
    message.textContent = text;
    message.className = `form-message ${type}`;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const name = String(data.get("name") || "").trim();
    const phone = String(data.get("phone") || "").trim();
    const digits = phone.replace(/\D/g, "");
    const date = String(data.get("date") || "");
    const time = String(data.get("time") || "");
    const guestsValue = String(data.get("guests") || "");
    let comment = String(data.get("comment") || "").trim();

    if (digits.length < 10 || digits.length > 15) {
      showMessage("Проверьте номер телефона с кодом страны.", "error");
      return;
    }

    if (date < getToday()) {
      showMessage("Дата посещения не может быть в прошлом.", "error");
      return;
    }

    if (!data.get("consent")) {
      showMessage("Необходимо согласие на обработку персональных данных.", "error");
      return;
    }

    if (!["1", "2", "3", "4", "5", "6", "7+"].includes(guestsValue)) {
      showMessage("Выберите количество гостей.", "error");
      return;
    }

    if (guestsValue === "7+") {
      comment = [comment, "Количество гостей: 7 или больше."]
        .filter(Boolean)
        .join(" ");
    }

    const submit = form.querySelector('button[type="submit"]');
    if (!submit) {
      showMessage("Не найдена кнопка отправки формы.", "error");
      return;
    }

    const originalText = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Отправляем заявку…";
    showMessage("Отправляем заявку…", "info");

    try {
      const response = await fetch(
        CONFIG.bookingEndpoint || DEFAULT_ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            phone,
            date,
            time,
            guests: guestsValue,
            comment,
            consent: true
          })
        }
      );

      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        throw new Error(
          result.error || `Ошибка сервера: ${response.status}`
        );
      }

      showMessage(
        result.message || "Заявка отправлена администратору!",
        "success"
      );

      form.reset();
      dateInput.min = getToday();
    } catch (error) {
      console.error("Ошибка отправки заявки:", error);
      showMessage(
        error.message || "Не удалось отправить заявку. Попробуйте позже.",
        "error"
      );
    } finally {
      submit.disabled = false;
      submit.textContent = originalText;
    }
  });
}