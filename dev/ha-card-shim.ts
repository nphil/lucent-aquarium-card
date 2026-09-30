/** Minimal `ha-card` stand-in (the real one ships with the HA frontend). */
if (!customElements.get("ha-card")) {
  class HaCardShim extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        :host {
          display: block;
          background: var(--ha-card-background, var(--card-background-color));
          border-radius: var(--ha-card-border-radius, 12px);
          border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color));
          box-shadow: var(--ha-card-box-shadow, none);
          backdrop-filter: var(--ha-card-backdrop-filter, none);
          -webkit-backdrop-filter: var(--ha-card-backdrop-filter, none);
          color: var(--primary-text-color);
        }
      </style><slot></slot>`;
    }
  }
  customElements.define("ha-card", HaCardShim);
}
