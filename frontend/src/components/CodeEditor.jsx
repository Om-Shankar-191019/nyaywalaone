import { cpp } from '@codemirror/lang-cpp';
import CodeMirror from '@uiw/react-codemirror';
import { useTheme } from '../theme/ThemeProvider.jsx';

const EXTENSIONS = [cpp()];

/** CodeMirror wrapper that follows the app theme. Used by the Day 6 sandbox. */
export function CodeEditor({ value, onChange, height = '15rem', readOnly = false, label }) {
  const { isDark } = useTheme();

  return (
    <div className="overflow-hidden rounded-lg border border-line" aria-label={label}>
      <CodeMirror
        value={value}
        height={height}
        theme={isDark ? 'dark' : 'light'}
        extensions={EXTENSIONS}
        onChange={onChange}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          autocompletion: false,
        }}
      />
    </div>
  );
}
