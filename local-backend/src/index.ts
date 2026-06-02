// @duel/local-backend
//
// Local persistence only: saves, decks, settings, replay command logs.
// Reads card data from assets/ (gitignored) via the importer scripts; never
// makes network calls.

export * from "./deck-store.ts";
