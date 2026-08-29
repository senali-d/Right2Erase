import nextConfig from 'eslint-config-next';
import prettierConfig from 'eslint-config-prettier';

const config = [
  ...nextConfig,
  {
    rules: {
      // Flags every fetch-on-mount effect (`useEffect(() => { void load(); }, [])`),
      // a pattern used throughout app/. Adopting the React Compiler-oriented
      // alternative is a data-fetching architecture change, out of scope for
      // introducing lint tooling.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  prettierConfig,
];

export default config;
