(() => {
  const pad = (value) => String(value).padStart(2, '0');

  document.querySelectorAll('[data-carousel]').forEach((carousel) => {
    const slides = [...carousel.querySelectorAll('[data-carousel-slide]')];
    const dots = carousel.querySelector('[data-carousel-dots]');
    if (!slides.length) return;
    let active = 0;

    const render = () => {
      slides.forEach((slide, index) => {
        const isActive = index === active;
        slide.hidden = !isActive;
        slide.setAttribute('aria-hidden', String(!isActive));
      });
      if (dots) {
        dots.replaceChildren(...slides.map((_, index) => {
          const dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'carousel-dot' + (index === active ? ' is-active' : '');
          dot.setAttribute('aria-label', `Слайд ${index + 1} з ${slides.length}`);
          dot.setAttribute('aria-current', String(index === active));
          dot.addEventListener('click', () => { active = index; render(); });
          return dot;
        }));
      }
    };

    carousel.querySelector('[data-carousel-prev]')?.addEventListener('click', () => {
      active = (active - 1 + slides.length) % slides.length;
      render();
    });
    carousel.querySelector('[data-carousel-next]')?.addEventListener('click', () => {
      active = (active + 1) % slides.length;
      render();
    });
    let touchStart = 0;
    carousel.addEventListener('touchstart', (event) => { touchStart = event.changedTouches[0]?.clientX || 0; }, { passive: true });
    carousel.addEventListener('touchend', (event) => {
      const delta = (event.changedTouches[0]?.clientX || 0) - touchStart;
      if (Math.abs(delta) < 45) return;
      active = (active + (delta < 0 ? 1 : -1) + slides.length) % slides.length;
      render();
    }, { passive: true });
    render();
  });

  document.querySelectorAll('[data-order-form]').forEach((form) => {
    const phone = form.querySelector('input[type="tel"]');
    const status = form.querySelector('.form-status');

    phone?.addEventListener('input', () => {
      let digits = phone.value.replace(/\D/g, '').replace(/^38/, '').slice(0, 10);
      if (!digits) { phone.value = ''; return; }
      const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 8), digits.slice(8, 10)];
      phone.value = '+38' + (parts[0] ? ' (' + parts[0] : '') + (parts[1] ? ') ' + parts[1] : '') + (parts[2] ? '-' + parts[2] : '') + (parts[3] ? '-' + parts[3] : '');
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (phone && phone.value.replace(/\D/g, '').length < 12) {
        phone.setCustomValidity('Введіть повний номер телефону');
        phone.reportValidity();
        phone.setCustomValidity('');
        return;
      }

      const name = form.querySelector('input[name="name"]')?.value.trim() || '';
      const button = form.querySelector('button[type="submit"]');
      const originalButtonText = button?.textContent || 'Замовити';
      if (button) { button.disabled = true; button.textContent = 'Надсилаємо…'; }
      if (status) {
        status.textContent = 'Надсилаємо заявку…';
        status.classList.add('is-visible');
      }

      try {
        const response = await fetch('https://powershop-fm-orders-api.onrender.com/api/order', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, phone: phone?.value || '' })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(result.code || 'order_failed');

        if (status) status.textContent = 'Дякуємо! Заявку надіслано. Менеджер скоро зв’яжеться з вами.';
        form.reset();
      } catch (error) {
        if (status) {
          status.textContent = error.message === 'not_configured'
            ? 'Заявки тимчасово не приймаються. Спробуйте пізніше.'
            : 'Не вдалося надіслати заявку. Перевірте інтернет і спробуйте ще раз.';
        }
      } finally {
        if (button) { button.disabled = false; button.textContent = originalButtonText; }
      }
    });;
  });

  const countdowns = document.querySelectorAll('[data-countdown]');
  // Keep the promotion timer looping: start at 24 hours and renew it once it
  // reaches 1 hour. localStorage keeps the countdown in sync after a refresh.
  const countdownPeriod = 24 * 60 * 60 * 1000;
  const countdownRenewAt = 60 * 60 * 1000;
  const countdownStorageKey = 'fm-promo-countdown-deadline';
  let deadline;
  try { deadline = Number(window.localStorage.getItem(countdownStorageKey)); } catch (_) {}
  if (!Number.isFinite(deadline) || deadline <= Date.now() + countdownRenewAt) {
    deadline = Date.now() + countdownPeriod;
    try { window.localStorage.setItem(countdownStorageKey, String(deadline)); } catch (_) {}
  }
  const updateCountdown = () => {
    let remaining = deadline - Date.now();
    if (remaining <= countdownRenewAt) {
      deadline = Date.now() + countdownPeriod;
      remaining = deadline - Date.now();
      try { window.localStorage.setItem(countdownStorageKey, String(deadline)); } catch (_) {}
    }
    const seconds = Math.floor(remaining / 1000);
    const values = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
    countdowns.forEach((timer) => timer.querySelectorAll('.count').forEach((count, index) => {
      const digits = pad(values[index]);
      count.innerHTML = `<span>${digits[0]}</span><span>${digits[1]}</span>`;
    }));
  };
  updateCountdown();
  const countdownInterval = window.setInterval(updateCountdown, 1000);

  const sticky = document.querySelector('.sticky-cta');
  const orderCards = document.querySelectorAll('.offer .order_form');
  if (sticky && orderCards.length > 1 && 'IntersectionObserver' in window) {
    let firstCardVisible = true;
    let lastCardVisible = false;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target === orderCards[0]) firstCardVisible = entry.isIntersecting;
        if (entry.target === orderCards[orderCards.length - 1]) lastCardVisible = entry.isIntersecting;
      });
      sticky.classList.toggle('show', !firstCardVisible && !lastCardVisible);
    }, { threshold: 0.12 });
    observer.observe(orderCards[0]);
    observer.observe(orderCards[orderCards.length - 1]);
  }
})();
