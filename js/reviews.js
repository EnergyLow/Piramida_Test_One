const API_URL = window.PIRAMIDA_CONFIG?.reviewsEndpoint
  || "http://localhost:3000/api/reviews";

const list = document.querySelector("#reviews-list");
const form = document.querySelector("#review-form");
const message = document.querySelector("#review-message");
const averageElement = document.querySelector("#reviews-average");
const averageStars = document.querySelector("#reviews-average-stars");
const countElement = document.querySelector("#reviews-count");

function showMessage(text, type = "") {
  if (!message) return;
  message.textContent = text;
  message.className = `form-message${type ? ` is-${type}` : ""}`;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatDate(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);
}

function renderReviews(data) {
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  const count = Number(data.count ?? reviews.length);
  const average = Number(data.average ?? 0);

  averageElement.textContent = count ? average.toFixed(1) : "—";

  const roundedAverage = Math.max(0, Math.min(5, Math.round(average)));

  averageStars.textContent = count
    ? "★".repeat(roundedAverage) + "☆".repeat(5 - roundedAverage)
    : "☆☆☆☆☆";

  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;

  let word = "отзывов";

  if (lastDigit === 1 && lastTwoDigits !== 11) {
    word = "отзыв";
  } else if (
    [2, 3, 4].includes(lastDigit) &&
    ![12, 13, 14].includes(lastTwoDigits)
  ) {
    word = "отзыва";
  }

  countElement.textContent = `${count} ${word}`;
  list.replaceChildren();

  if (!reviews.length) {
    list.append(
      makeElement(
        "p",
        "reviews-empty",
        "Пока отзывов нет. Будьте первым, кто поделится впечатлениями!"
      )
    );
    return;
  }

  for (const review of reviews) {
    const card = makeElement("article", "review-card");
    const header = makeElement("div", "review-card-header");

    const author = makeElement(
      "h3",
      "review-author",
      String(review.name || "Гость")
    );

    const rating = Math.max(
      1,
      Math.min(5, Number(review.rating) || 1)
    );

    const stars = makeElement(
      "span",
      "review-stars",
      "★".repeat(rating) + "☆".repeat(5 - rating)
    );

    stars.setAttribute("aria-label", `Оценка: ${rating} из 5`);

    header.append(author, stars);
    card.append(header);

    const dateText = formatDate(review.createdAt || review.date);

    if (dateText) {
      const time = makeElement("time", "review-date", dateText);
      time.dateTime = review.createdAt || review.date;
      card.append(time);
    }

    // textContent защищает от интерпретации текста отзыва как HTML.
    card.append(
      makeElement("p", "review-text", String(review.text || ""))
    );

    list.append(card);
  }
}

async function loadReviews() {
  try {
    const response = await fetch(API_URL);
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Не удалось загрузить отзывы.");
    }

    renderReviews(data);
  } catch (error) {
    list.replaceChildren(
      makeElement(
        "p",
        "reviews-error",
        "Не удалось загрузить отзывы. Проверьте подключение и попробуйте обновить страницу."
      )
    );

    countElement.textContent = "Отзывы временно недоступны";

    console.error("Ошибка загрузки отзывов:", error);
  }
}

async function handleReviewSubmit(event) {
  event.preventDefault();

  if (!form.reportValidity()) return;

  const submitButton = form.querySelector('button[type="submit"]');

  if (!submitButton) return;

  const fields = new FormData(form);

  const payload = {
    name: String(fields.get("name") || "").trim(),
    rating: Number(fields.get("rating")),
    text: String(fields.get("text") || "").trim(),
    website: String(fields.get("website") || ""),
    consent: fields.get("consent") === "on"
  };

  if (
    payload.name.length < 2 ||
    payload.text.length < 10 ||
    !Number.isInteger(payload.rating) ||
    payload.rating < 1 ||
    payload.rating > 5
  ) {
    showMessage("Проверьте имя, текст отзыва и оценку.", "error");
    return;
  }

  submitButton.disabled = true;
  showMessage("Отправляем отзыв…");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Не удалось отправить отзыв.");
    }

    form.reset();

    showMessage("Спасибо! Ваш отзыв отправлен.", "success");

    await loadReviews();
  } catch (error) {
    showMessage(
      error.message || "Ошибка отправки. Попробуйте ещё раз.",
      "error"
    );

    console.error("Ошибка отправки отзыва:", error);
  } finally {
    submitButton.disabled = false;
  }
}

export function initReviews() {
  if (
    !list ||
    !form ||
    !message ||
    !averageElement ||
    !averageStars ||
    !countElement
  ) {
    console.error(
      "Отзывы: не найдены необходимые элементы в HTML. Проверьте ID блока отзывов."
    );
    return;
  }

  form.addEventListener("submit", handleReviewSubmit);

  loadReviews();
}
