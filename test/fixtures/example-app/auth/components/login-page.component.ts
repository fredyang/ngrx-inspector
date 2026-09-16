import { Component, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { Credentials } from '../models/user';
import * as authState from '../store/auth.state';
import { LoginPageEvents } from '../store/auth.events';
import { LoginFormComponent } from '../components/login-form.component';

@Component({
  selector: 'bc-login-page',
  template: `
    <bc-login-form
      (submitted)="onSubmit($event)"
      [pending]="pending()"
      [errorMessage]="error()"
    >
    </bc-login-form>
  `,
  styles: '',
  imports: [LoginFormComponent],
})
export class LoginPageComponent {
  private readonly store = inject(Store);

  readonly pending = this.store.selectSignal(authState.selectLoginPagePending);
  readonly error = this.store.selectSignal(authState.selectLoginPageError);

  onSubmit(credentials: Credentials) {
    this.store.dispatch(LoginPageEvents.login({ credentials }));
  }
}
