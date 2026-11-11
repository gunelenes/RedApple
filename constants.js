'use strict';

// Knight Online job'ları (sıralama, üye listesindeki sıralamayı da belirler)
const JOBS = ['Warrior', 'Rogue', 'Mage', 'Priest', 'Kurian'];

// Duyuru türleri
const TYPES = {
  genel: { label: 'Duyuru' },
  toplanti: { label: 'Toplantı' },
  etkinlik: { label: 'Etkinlik' },
  drop: { label: 'Drop' },
};

module.exports = { JOBS, TYPES };
