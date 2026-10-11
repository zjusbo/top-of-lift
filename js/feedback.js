// Feedback contact in the footer, hidden from address-harvesting bots.
//
// The address never appears as plain text in the HTML or this repo: it is stored reversed and
// base64-encoded, and only decoded after a visitor answers a small arithmetic question.
// Answers typed in under a second and a filled honeypot field are treated as bots.
// This stops scrapers, which are the main source of spam; it is not a CAPTCHA.

const ENCODED = 'bW9jLmxpYW1nQHlubnVzLm9iZ25vcw==';
const MIN_HUMAN_MS = 1000;

const address = () => atob(ENCODED).split('').reverse().join('');

export function initFeedback(root) {
  const showBtn = root.querySelector('#fb-show');
  const form = root.querySelector('#fb-check');
  const question = root.querySelector('#fb-question');
  const answer = root.querySelector('#fb-answer');
  const trap = root.querySelector('#fb-website');
  const msg = root.querySelector('#fb-msg');
  const out = root.querySelector('#fb-address');
  let a, b, shownAt;

  const newQuestion = () => {
    a = 2 + Math.floor(Math.random() * 8);
    b = 2 + Math.floor(Math.random() * 8);
    question.textContent = `What is ${a} + ${b}?`;
    answer.value = '';
    shownAt = Date.now();
  };

  showBtn.addEventListener('click', () => {
    showBtn.hidden = true;
    form.hidden = false;
    newQuestion();
    answer.focus();
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const tooFast = Date.now() - shownAt < MIN_HUMAN_MS;
    if (trap.value || tooFast || +answer.value.trim() !== a + b) {
      msg.textContent = 'Not quite. Try this one.';
      newQuestion();
      return;
    }
    const email = address();
    const link = document.createElement('a');
    link.href = `mailto:${email}?subject=${encodeURIComponent('Top of Lift feedback')}`;
    link.textContent = email;
    out.replaceChildren('Send feedback to ', link);
    form.hidden = true;
    msg.textContent = '';
  });
}
