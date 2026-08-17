import { createContext, useContext } from "react";

/**
 * True when the page reading it is the one on screen.
 *
 * The Duel page stays mounted after you leave it, so an in-progress duel is not
 * torn down by clicking another tab. It is only hidden — which means its global
 * key handlers would still fire over the Cards search box or the deck editor
 * unless they check this first.
 */
export const TabActiveContext = createContext(true);

export const useTabActive = (): boolean => useContext(TabActiveContext);
