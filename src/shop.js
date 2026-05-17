export const BUFFS = [
  { id: 'speed',     name: 'Speed Boost',    desc: '+30% walk speed for 30s',         cost: 30, apply: { type: 'speed',     mult: 1.3, duration: 30 } },
  { id: 'reload',    name: 'Quick Hands',    desc: 'Reloads 50% faster for 30s',      cost: 35, apply: { type: 'reload',    mult: 0.5, duration: 30 } },
  { id: 'damage',    name: 'Sharp Edges',    desc: '+30% damage for 30s',             cost: 50, apply: { type: 'damage',    mult: 1.3, duration: 30 } },
  { id: 'multishot', name: 'Multishot',      desc: '+1 projectile per shot for 25s',  cost: 65, apply: { type: 'multishot', add: 1,    duration: 25 } },
  { id: 'health',    name: 'Bigger Spud',    desc: '+50 max HP and full heal',        cost: 40, apply: { type: 'health',    add: 50 } },
  { id: 'ammo',      name: 'Ammo Refill',    desc: 'Top off current weapon reserves', cost: 20, apply: { type: 'ammo' } },
];

export class Shop {
  constructor(game) {
    this.game = game;
    this.modal = document.getElementById('shop-modal');
    this.list = document.getElementById('shop-items');
    this.coinDisplay = document.getElementById('shop-coins');
    this.closeBtn = document.getElementById('shop-close');
    this.buildItems();
    this.closeBtn.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (this.modal.classList.contains('open') && e.code === 'Escape') {
        this.close();
      }
    });
  }

  buildItems() {
    this.list.innerHTML = '';
    for (const b of BUFFS) {
      const row = document.createElement('button');
      row.className = 'shop-item';
      row.dataset.id = b.id;
      row.innerHTML = `
        <div class="shop-item-name">${b.name}</div>
        <div class="shop-item-desc">${b.desc}</div>
        <div class="shop-item-cost">${b.cost}<span class="coin">¢</span></div>
      `;
      row.addEventListener('click', () => this.buy(b));
      this.list.appendChild(row);
    }
  }

  buy(buff) {
    const p = this.game.player;
    if (p.coins < buff.cost) {
      this.flashItem(buff.id, false);
      return;
    }
    p.coins -= buff.cost;
    p.applyBuff(buff.apply.type, buff.apply);
    this.game.hud.addPickupMessage(`Bought: ${buff.name}`);
    this.flashItem(buff.id, true);
    this.refresh();
  }

  flashItem(id, success) {
    const el = this.list.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.classList.add(success ? 'flash-ok' : 'flash-fail');
    setTimeout(() => el.classList.remove('flash-ok', 'flash-fail'), 400);
  }

  open() {
    this.refresh();
    this.modal.classList.add('open');
    document.exitPointerLock();
  }

  close() {
    this.modal.classList.remove('open');
    if (this.game.running && !this.game.player.dead && !this.game.matchOver) {
      this.game.canvas.requestPointerLock();
    }
  }

  refresh() {
    this.coinDisplay.textContent = this.game.player.coins;
    for (const b of BUFFS) {
      const el = this.list.querySelector(`[data-id="${b.id}"]`);
      el.classList.toggle('cant-afford', this.game.player.coins < b.cost);
    }
  }

  isOpen() {
    return this.modal.classList.contains('open');
  }
}
