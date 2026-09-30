/** Bundle entry point: importing a module registers its custom elements. Each card pulls in every
 * component it renders; the primitives are listed so the bundle never depends on import order.
 * Two cards ship together: the aquarium light card and the aquarium equipment card. */
import "./components/aq-icon-button.ts";
import "./components/aq-pill-button.ts";
import "./components/aq-chip.ts";
import "./components/aq-notice.ts";
import "./components/aq-skeleton.ts";
import "./components/aq-toast.ts";
import "./components/aq-switch.ts";
import "./components/aquarium-sheet.ts";
import "./components/aquarium-slider.ts";
import "./components/aquarium-hold-button.ts";
import "./components/aquarium-light-card.ts";
import "./components/aquarium-equipment-card.ts";
