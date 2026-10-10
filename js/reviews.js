
import { supabase } from "./supabase.js";

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

function renderReviews(reviews) {
  const count = reviews.length;
  const average = count
    ? reviews.reduce((sum, review) => sum + Number(review.rating), 0) / count
    : 0;

  averageElement.textContent = count ? average.toFixed(1) : "—";
  const rounded = Math.round(average);

  averageStars.textContent = count
    ? "★".repeat(rounded) + "☆".repeat(5 - rounded)
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

  if (!count) {
    list.append(makeElement(
      "p",
      "reviews-empty",
      "Пока отзывов нет. Будьте первым, кто поделится впечатлениями!"
    ));
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

    const rating = Math.max(1, Math.min(5, Number(review.rating) || 1));
    const stars = makeElement(
      "span",
      "review-stars",
      "★".repeat(rating) + "☆".repeat(5 - rating)
    );

    stars.setAttribute("aria-label", `Оценка: ${rating} из 5`);
    header.append(author, stars);
    card.append(header);

    const dateText = formatDate(review.created_at);

    if (dateText) {
      const time = makeElement("time", "review-date", dateText);
      time.dateTime = review.created_at;
      card.append(time);
    }

    card.append(makeElement(
      "p",
      "review-text",
      String(review.review_text || "")
    ));

    list.append(card);
  }
}

async function loadReviews() {
  try {
    const { data, error } = await supabase
      .from("reviews")
      .select("id, name, rating, review_text, created_at")
      .order("created_at", { ascending: false });

    if (error) throw error;
    renderReviews(data || []);
  } catch (error) {
    console.error("Ошибка загрузки отзывов:", error);

    list.replaceChildren(makeElement(
      "p",
      "reviews-error",
      "Не удалось загрузить отзывы. Попробуйте обновить страницу."
    ));

    countElement.textContent = "Отзывы временно недоступны";
  }
}

async function handleReviewSubmit(event) {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const submitButton = form.querySelector('button[type="submit"]');
  if (!submitButton) return;

  const fields = new FormData(form);
  const name = String(fields.get("name") || "").trim();
  const rating = Number(fields.get("rating"));
  const text = String(fields.get("text") || "").trim();
  const website = String(fields.get("website") || "").trim();
  const consent = fields.get("consent") === "on";

  if (website) {
    form.reset();
    showMessage("Спасибо за отзыв!", "success");
    return;
  }

  if (!consent) {
    showMessage("Необходимо согласие на обработку персональных данных.", "error");
    return;
  }

  if (
    name.length < 2 ||
    text.length < 10 ||
    text.length > 2000 ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5
  ) {
    showMessage("Проверьте имя, текст отзыва и оценку.", "error");
    return;
  }

  const originalText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = "Отправляем…";
  showMessage("Сохраняем отзыв…");

  try {
    const { error } = await supabase
      .from("reviews")
      .insert({ name, rating, review_text: text });

    if (error) throw error;

    form.reset();
    showMessage("Спасибо! Ваш отзыв опубликован.", "success");
    await loadReviews();
  } catch (error) {
    console.error("Ошибка отправки отзыва:", error);
    showMessage("Не удалось отправить отзыв. Попробуйте ещё раз.", "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalText;
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
    console.error("Отзывы: не найдены необходимые элементы HTML.");
    return;
  }

  form.addEventListener("submit", handleReviewSubmit);
  loadReviews();
}