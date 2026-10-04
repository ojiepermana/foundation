import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ButtonComponent } from '@ojiepermana/angular/component/button';
import {
  CardComponent,
  CardContentComponent,
  CardDescriptionComponent,
  CardFooterComponent,
  CardHeaderComponent,
  CardTitleComponent,
} from '@ojiepermana/angular/component/card';
import { SpinnerComponent } from '@ojiepermana/angular/component/spinner';
import { ReadinessApi, type ReadinessResult } from './readiness-api';

type ReadinessState = ReadinessResult['status'] | 'loading';

/** Fixed texts of the status element (spec 0006, *Teks dan state halaman*). */
const MESSAGES: Readonly<Record<ReadinessState, string>> = {
  loading: 'Memeriksa database.',
  available: 'Database dapat dibaca.',
  unavailable: 'Database tidak tersedia. Pastikan PostgreSQL berjalan, lalu periksa ulang.',
  busy: 'Pemeriksaan lain masih berjalan. Tunggu sebentar, lalu periksa ulang.',
  network: 'Backend tidak dapat dihubungi. Pastikan layanan development berjalan, lalu periksa ulang.',
  failed: 'Pemeriksaan gagal. Periksa ulang beberapa saat lagi.',
};

interface ReadinessView {
  state: ReadinessState;
  message: string;
  /** `datetime` keeps the server string as is; `text` follows the browser locale and time zone. */
  checkedAt?: { datetime: string; text: string };
  appliedMigrations?: string;
}

@Component({
  selector: 'app-readiness-page',
  imports: [
    ButtonComponent,
    CardComponent,
    CardContentComponent,
    CardDescriptionComponent,
    CardFooterComponent,
    CardHeaderComponent,
    CardTitleComponent,
    SpinnerComponent,
  ],
  templateUrl: './readiness-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReadinessPage {
  private readonly api = inject(ReadinessApi);
  private readonly timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

  /** One check when the page opens, then one per `recheck()`; destroying the page cancels a running request. */
  protected readonly check = rxResource({ stream: () => this.api.check() });
  protected readonly loading = computed(() => this.check.isLoading());

  protected readonly view = computed<ReadinessView>(() => {
    // While a request runs the previous result is hidden, so a failed check never shows an old count.
    if (this.check.isLoading()) return { state: 'loading', message: MESSAGES.loading };
    if (!this.check.hasValue()) {
      const state: ReadinessState = this.check.status() === 'error' ? 'failed' : 'loading';
      return { state, message: MESSAGES[state] };
    }
    const result = this.check.value();
    const view: ReadinessView = { state: result.status, message: MESSAGES[result.status] };
    if (result.status === 'available' || result.status === 'unavailable') {
      view.checkedAt = { datetime: result.checkedAt, text: this.timeFormat.format(new Date(result.checkedAt)) };
    }
    if (result.status === 'available') view.appliedMigrations = String(result.appliedMigrations);
    return view;
  });

  protected recheck(): void {
    if (this.check.isLoading()) return;
    this.check.reload();
  }
}
