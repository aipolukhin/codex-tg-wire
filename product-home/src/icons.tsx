import type { SVGProps } from 'react'

type Props = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: Props) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>
}

export function SearchIcon(props: Props) {
  return <Icon {...props}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></Icon>
}

export function HomeIcon(props: Props) {
  return <Icon {...props}><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></Icon>
}

export function GridIcon(props: Props) {
  return <Icon {...props}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Icon>
}

export function ReviewIcon(props: Props) {
  return <Icon {...props}><path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></Icon>
}

export function LinkIcon(props: Props) {
  return <Icon {...props}><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/></Icon>
}

export function CheckIcon(props: Props) {
  return <Icon {...props}><path d="m5 12 4 4L19 6"/></Icon>
}

export function ClockIcon(props: Props) {
  return <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>
}

export function ArrowIcon(props: Props) {
  return <Icon {...props}><path d="m9 18 6-6-6-6"/></Icon>
}
