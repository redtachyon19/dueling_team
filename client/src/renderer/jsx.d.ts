// React 19's @types/react no longer declares a *global* `JSX` namespace — it
// lives under `React.JSX`. Our components use the bare `JSX.Element` return
// type (the long-standing convention), so we re-expose the global namespace
// here, aliased to React's. One shim instead of annotating every component.
import type { JSX as ReactJSX } from "react";

declare global {
  namespace JSX {
    type ElementType = ReactJSX.ElementType;
    interface Element extends ReactJSX.Element {}
    interface ElementClass extends ReactJSX.ElementClass {}
    interface ElementAttributesProperty extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactJSX.ElementChildrenAttribute {}
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>;
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends ReactJSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}
