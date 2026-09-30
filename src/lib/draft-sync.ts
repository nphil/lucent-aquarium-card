/** What a visual card editor keeps between the form and Home Assistant.
 *
 * The form can hold things the card's configuration cannot yet: a program helper picked before
 * its automation, a range typed before its sensor, an outlet with no switch. If the editor
 * rebuilt the form from the configuration after every change, those half-filled fields would
 * vanish the moment they were entered. So the editor keeps its own `draft` and only reports the
 * configuration made from it.
 *
 * Home Assistant answers a `config-changed` by calling `setConfig` with the very configuration it
 * was given. That echo must not replace the draft; a configuration that is NOT an echo (the
 * person switched to the YAML editor and changed it, or opened another card) must. */

import { sameJson } from "./json.ts";

export class DraftSync<Form, Config> {
  draft: Form;
  private emitted: Config | undefined;

  constructor(
    private readonly toForm: (config: Config) => Form,
    private readonly toConfig: (form: Form, base: Config) => Config,
    initial: Config,
  ) {
    this.draft = toForm(initial);
  }

  /** Home Assistant set the configuration. Returns true when the form was rebuilt from it, false
   * when it was only the echo of the last change and the draft was kept. */
  receive(config: Config): boolean {
    const echo = this.emitted !== undefined && sameJson(config, this.emitted);
    this.emitted = undefined;
    if (echo) return false;
    this.draft = this.toForm(config);
    return true;
  }

  /** The person changed the form: remember the draft and return the configuration to report. */
  edit(form: Form, base: Config): Config {
    this.draft = form;
    const config = this.toConfig(form, base);
    this.emitted = config;
    return config;
  }
}
