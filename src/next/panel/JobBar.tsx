/**
 * The bar of something opened in place of its tab's list: a routine, a
 * trigger, a T3 thread. Back clears `param`, the route key that opened it, so
 * the list returns the same way in each; `children` are its actions.
 */
import type { ReactNode } from 'react'
import { getRoute, goBack, withRoute } from '../router'
import { IconButton } from '../ui/primitives'
import { IChevronLeft } from '../ui/icons'

export function JobBar({ param, label, title, children }: { param: string; label: string; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="nx-job__bar">
      <IconButton small label={label} onClick={() => goBack(withRoute(getRoute(), { params: { [param]: null } }))}>
        <IChevronLeft />
      </IconButton>
      {title !== undefined && <h3>{title}</h3>}
      {children}
    </div>
  )
}
