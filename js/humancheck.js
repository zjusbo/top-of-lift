// Small arithmetic check shared by the feedback and alert forms. Wrong sums, answers typed in
// under a second, and a filled honeypot field all fail. It stops form bots and address
// harvesters; it is not a CAPTCHA.

const MIN_HUMAN_MS = 1000;

export function humanCheck(questionEl) {
  let a, b, shownAt;
  const next = () => {
    a = 2 + Math.floor(Math.random() * 8);
    b = 2 + Math.floor(Math.random() * 8);
    questionEl.textContent = `Quick check: what is ${a} + ${b}?`;
    shownAt = Date.now();
  };
  next();
  return {
    next,
    passed: (answer, trapValue) =>
      !trapValue && Date.now() - shownAt >= MIN_HUMAN_MS && +String(answer).trim() === a + b,
  };
}
