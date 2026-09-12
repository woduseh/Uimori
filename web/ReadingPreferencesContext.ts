import { createContext } from 'react';
import { DEFAULT_READABILITY } from './reading-preferences.js';

export const ReadingPreferencesContext = createContext(DEFAULT_READABILITY);
