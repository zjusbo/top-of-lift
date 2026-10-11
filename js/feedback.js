// Feedback contact in the footer, hidden from address-harvesting bots.
//
// The address never appears as plain text in the HTML or this repo: it is stored reversed and
// base64-encoded, and only decoded after a visitor passes the human check.
import { humanCheck } from './humancheck.js';

const ENCODED = 'bW9jLmxpYW1nQHlubnVzLm9iZ25vcw==';

const address = () => atob(ENCODED).split('').reverse().join('');

export function initFeedback(root) {
  const showBtn = root.querySelector('#fb-show');
  const form = root.querySelector('#fb-check');
  const answer = root.querySelector('#fb-answer');
  const trap = root.querySelector('#fb-website');
  const msg = root.querySelector('#fb-msg');
  const out = root.querySelector('#fb-address');
  let check;

  showBtn.addEventListener('click', () => {
    showBtn.hidden = true;
    form.hidden = false;
    check = humanCheck(root.querySelector('#fb-question'));
    answer.focus();
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (!check.passed(answer.value, trap.value)) {
      msg.textContent = 'Not quite. Try this one.';
      answer.value = '';
      check.next();
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
