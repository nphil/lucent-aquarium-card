import { LitElement, css, html } from "lit";
import { TOKENS_CSS } from "../styles/tokens.ts";

/** A fixed-geometry placeholder while something loads. Static (no shimmer); it is replaced
 * atomically and never stands in for content that failed to load. */
export class LuSkeleton extends LitElement {
  static properties = {
    label: { type: String },
    height: { type: String },
  };

  declare label: string;
  declare height: string;

  constructor() {
    super();
    this.label = "Loading";
    this.height = "var(--lu-space-8)";
  }

  render() {
    return html`<div class="skeleton" role="status" aria-label=${this.label} style=${`height:${this.height}`}></div>`;
  }

  static styles = [
    TOKENS_CSS,
    css`
      :host { display: block; min-width: 0; }
      .skeleton { width: 100%; border-radius: var(--lu-radius-tile); background: var(--lu-tile); }
    `,
  ];
}

customElements.define("aq-skeleton", LuSkeleton);

declare global {
  interface HTMLElementTagNameMap {
    "aq-skeleton": LuSkeleton;
  }
}
