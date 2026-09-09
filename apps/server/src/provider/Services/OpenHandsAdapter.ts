/**
 * OpenHandsAdapter — shape type for the OpenHands provider adapter.
 *
 * Like {@link ../Drivers/CursorDriver}, the driver bundles one adapter per
 * instance as a captured closure, so there is no `Context.Service` tag here —
 * only the shape interface as a naming anchor for the driver bundle.
 *
 * @module OpenHandsAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpenHandsAdapterShape — per-instance OpenHands adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface OpenHandsAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
