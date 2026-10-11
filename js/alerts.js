// "Email alerts" sign-up form. The Apps Script backend (alerts/Code.gs) stores the address,
// sends a confirmation email (double opt-in), and emails confirmed subscribers when a site
// looks flyable.
import { ALERTS_ENDPOINT } from './config.js';
import { humanCheck } from './humancheck.js';
import { el } from './format.js';

export function initAlerts(root, sites) {
  const form = root.querySelector('#alert-form');
  const email = root.querySelector('#alert-email');
  const answer = root.querySelector('#alert-answer');
  const trap = root.querySelector('#alert-website');
  const msg = root.querySelector('#alert-msg');
  const button = form.querySelector('button[type=submit]');

  root.querySelector('#alert-sites').replaceChildren(...sites.map(s => el('label', { class: 'check' },
    el('input', { type: 'checkbox', name: 'site', value: s.id, checked: true }), ` ${s.name}`)));

  if (!ALERTS_ENDPOINT) {
    for (const input of form.querySelectorAll('input, button')) input.disabled = true;
    msg.textContent = 'Alerts are not switched on yet.';
    return;
  }

  const check = humanCheck(root.querySelector('#alert-question'));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const chosen = [...form.querySelectorAll('input[name=site]:checked')].map(i => i.value);
    if (!chosen.length) { msg.textContent = 'Pick at least one site.'; return; }
    if (!check.passed(answer.value, trap.value)) {
      msg.textContent = 'Not quite. Try this sum.';
      answer.value = '';
      check.next();
      return;
    }
    button.disabled = true;
    msg.textContent = 'Sending…';
    try {
      // text/plain body keeps this a "simple" request (no CORS preflight), which Apps Script needs.
      const res = await fetch(ALERTS_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({ email: email.value.trim(), sites: chosen, website: trap.value }),
      });
      const body = await res.json();
      msg.textContent = body.message;
      if (body.ok) form.reset();
    } catch {
      msg.textContent = "Couldn't reach the alert service. Please try again later.";
    } finally {
      button.disabled = false;
      answer.value = '';
      check.next();
    }
  });
}
