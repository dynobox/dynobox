import {Eye, EyeOff} from 'lucide-react';
import {useState} from 'react';

type PasswordFieldProps = {
  autoComplete: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
};

export function PasswordField({
  autoComplete,
  label,
  onChange,
  value,
}: PasswordFieldProps) {
  const inputId = label.toLowerCase().replaceAll(' ', '-');
  const [showPassword, setShowPassword] = useState(false);

  return (
    <label className="auth-field" htmlFor={inputId}>
      <span>{label}</span>
      <span className="password-input-wrap">
        <input
          autoComplete={autoComplete}
          id={inputId}
          minLength={8}
          onChange={(event) => onChange(event.target.value)}
          required
          type={showPassword ? 'text' : 'password'}
          value={value}
        />
        {value.length > 0 && (
          <button
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            className="password-toggle"
            onClick={() => setShowPassword((value) => !value)}
            type="button"
          >
            {showPassword ? (
              <Eye aria-hidden="true" size={18} />
            ) : (
              <EyeOff aria-hidden="true" size={18} />
            )}
          </button>
        )}
      </span>
    </label>
  );
}
