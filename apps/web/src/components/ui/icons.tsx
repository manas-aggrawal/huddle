import type { SVGProps } from 'react';

// Small inline icons (24×24 grid, stroke = currentColor).
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({
	size = 16,
	children,
	...rest
}: IconProps & { children: React.ReactNode }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
			{...rest}
		>
			{children}
		</svg>
	);
}

export const CheckIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M20 6 9 17l-5-5" />
	</Svg>
);
export const CircleIcon = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="12" cy="12" r="8" />
	</Svg>
);
export const DotIcon = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
	</Svg>
);
export const LockIcon = (p: IconProps) => (
	<Svg {...p}>
		<rect x="5" y="11" width="14" height="10" rx="2" />
		<path d="M8 11V7a4 4 0 0 1 8 0v4" />
	</Svg>
);
export const AlertIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M12 9v4M12 17h.01" />
		<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
	</Svg>
);
export const SkipIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M5 12h14M13 6l6 6-6 6" />
	</Svg>
);
export const CopyIcon = (p: IconProps) => (
	<Svg {...p}>
		<rect x="9" y="9" width="12" height="12" rx="2" />
		<path d="M5 15V5a2 2 0 0 1 2-2h10" />
	</Svg>
);
export const XIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M18 6 6 18M6 6l12 12" />
	</Svg>
);
export const LinkIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
		<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
	</Svg>
);
export const BotIcon = (p: IconProps) => (
	<Svg {...p}>
		<rect x="4" y="8" width="16" height="12" rx="3" />
		<path d="M12 4v4M9 14h.01M15 14h.01" />
	</Svg>
);

export const GripIcon = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="9" cy="6" r="1" />
		<circle cx="15" cy="6" r="1" />
		<circle cx="9" cy="12" r="1" />
		<circle cx="15" cy="12" r="1" />
		<circle cx="9" cy="18" r="1" />
		<circle cx="15" cy="18" r="1" />
	</Svg>
);
export const MoreIcon = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="5" cy="12" r="1" />
		<circle cx="12" cy="12" r="1" />
		<circle cx="19" cy="12" r="1" />
	</Svg>
);
export const PlusIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M12 5v14M5 12h14" />
	</Svg>
);
export const SearchIcon = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.5-3.5" />
	</Svg>
);
export const PageIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
		<path d="M14 3v5h5M9 13h6M9 17h6" />
	</Svg>
);
export const BellIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
		<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
	</Svg>
);
