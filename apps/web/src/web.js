for (const form of document.querySelectorAll('form[data-json-form]')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const confirmText = form.dataset.confirm;
    if (confirmText && !window.confirm(confirmText)) return;

    const submitter = event.submitter;
    if (submitter) submitter.disabled = true;

    const formData = new FormData(form);
    const payload = {};
    for (const [key, value] of formData.entries()) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        payload[key] = Array.isArray(payload[key]) ? [...payload[key], value] : [payload[key], value];
      } else {
        payload[key] = value;
      }
    }

    try {
      const res = await fetch(form.action, {
        method: form.method || 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `Request failed with ${res.status}`);
      window.location.assign(body.redirectTo || window.location.href);
    } catch (error) {
      window.alert(String(error.message || error));
      if (submitter) submitter.disabled = false;
    }
  });
}
