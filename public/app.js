'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // Silme işlemlerinde onay iste
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  // Yedekten geri yükleme: dosyayı ham olarak gönder
  const restoreForm = document.querySelector('[data-restore-form]');
  if (restoreForm) {
    restoreForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = restoreForm.querySelector('input[type="file"]').files[0];
      if (!file) return;
      const msg = 'Mevcut TÜM üyeler ve duyurular silinip "' + file.name + '" içindeki verilerle değiştirilecek. Emin misin?';
      if (!window.confirm(msg)) return;
      const btn = restoreForm.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Yükleniyor…';
      try {
        await fetch(restoreForm.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
      } catch {}
      window.location.href = '/yedek';
    });
  }

  // Duyuru formu: türe göre alanları göster/gizle
  document.querySelectorAll('[data-ann-form]').forEach((form) => {
    const sections = form.querySelectorAll('[data-show-for]');
    const update = () => {
      const checked = form.querySelector('input[name="type"]:checked');
      const type = checked ? checked.value : '';
      sections.forEach((el) => {
        el.hidden = !el.dataset.showFor.split(' ').includes(type);
      });
    };
    form.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', update));
    update();

    // Drop: üye seçimi araçları
    const box = form.querySelector('[data-attendees]');
    if (!box) return;
    const boxes = () => [...box.querySelectorAll('input[type="checkbox"]')];
    const counter = box.querySelector('[data-attendee-count]');
    const refreshCount = () => {
      if (counter) counter.textContent = `(${boxes().filter((c) => c.checked).length} seçili)`;
    };
    box.addEventListener('change', refreshCount);
    refreshCount();

    const visible = () => boxes().filter((c) => !c.closest('.attendee').hidden);
    const all = box.querySelector('[data-check-all]');
    const none = box.querySelector('[data-check-none]');
    if (all) all.addEventListener('click', () => { visible().forEach((c) => (c.checked = true)); refreshCount(); });
    if (none) none.addEventListener('click', () => { boxes().forEach((c) => (c.checked = false)); refreshCount(); });

    const search = box.querySelector('[data-attendee-search]');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLocaleLowerCase('tr');
        box.querySelectorAll('.attendee').forEach((el) => {
          el.hidden = q !== '' && !el.dataset.name.includes(q);
        });
      });
      // Arama kutusunda Enter formu göndermesin
      search.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    }
  });
});
