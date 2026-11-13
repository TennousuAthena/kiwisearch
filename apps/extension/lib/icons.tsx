import type { SVGProps } from 'react';

// One icon family: 24px grid, 1.75 stroke, round caps. Sized by font-size via 1em.
function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

export const SearchIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </Icon>
);

export const SlidersIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Icon>
);

export const TriangleAlertIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M12 4 3 19.5h18z" />
    <path d="M12 10v4.5M12 17.4v.1" />
  </Icon>
);

export const CircleAlertIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5M12 16v.1" />
  </Icon>
);

export const CheckIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const CopyIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Icon>
);

export const RotateIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Icon>
);

export const ChevronDownIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
);

export const CloseIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
  </Icon>
);

export const ExternalLinkIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M14 4.5h5.5V10M19.5 4.5 11 13" />
    <path d="M18 14v3.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10" />
  </Icon>
);

export const ArrowLeftIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M19 12H5.5M11 6l-6 6 6 6" />
  </Icon>
);

export const ArrowRightIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M5 12h13.5M13 6l6 6-6 6" />
  </Icon>
);

export const SparkleIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M12 3.5c.7 4.6 2.9 6.8 7.5 7.5-4.6.7-6.8 2.9-7.5 7.5-.7-4.6-2.9-6.8-7.5-7.5 4.6-.7 6.8-2.9 7.5-7.5Z" />
  </Icon>
);

export const HeartIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M12 19.5s-7-4.3-7-9.6a3.9 3.9 0 0 1 7-2.3 3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6Z" />
  </Icon>
);

// Search navigation glyphs from Lucide; see assets/interface-icons/NOTICE.md.
// Paths are unchanged; the shared wrapper uses Kiwi’s existing 1.75px stroke.
export const GlobeIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </Icon>
);

export const ImageIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </Icon>
);

export const CirclePlayIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z" />
    <circle cx="12" cy="12" r="10" />
  </Icon>
);

export const NewspaperIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M15 18h-5" />
    <path d="M18 14h-8" />
    <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2" />
    <rect width="8" height="4" x="10" y="6" rx="1" />
  </Icon>
);

export const ShoppingBagIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M16 10a4 4 0 0 1-8 0" />
    <path d="M3.103 6.034h17.794" />
    <path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z" />
  </Icon>
);

export const GraduationCapIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
    <path d="M22 10v6" />
    <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
  </Icon>
);

export const MessagesSquareIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    <path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" />
  </Icon>
);

export const MessageCircleQuestionIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
    <path d="M9 9.5a3 2.5 0 016 0c0 2-2 2-3 3.5" />
    <path d="M12 17h.01" />
  </Icon>
);

export const NotebookIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M2 6h4" />
    <path d="M2 10h4" />
    <path d="M2 14h4" />
    <path d="M2 18h4" />
    <rect width="16" height="20" x="4" y="2" rx="2" />
    <path d="M16 2v20" />
  </Icon>
);

export const BookOpenTextIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M12 5v16" />
    <path d="M16 13h2" />
    <path d="M16 9h2" />
    <path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z" />
    <path d="M6 13h2" />
    <path d="M6 9h2" />
  </Icon>
);

// Reuses the existing authentic X brand mark; its geometry is not redrawn.
export const XBrandIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon viewBox="0 0 251 256" fill="currentColor" stroke="none" {...props}>
    <path d="M149.079 108.399L242.33 0h-22.098l-80.97 94.12L74.59 0H0l97.796 142.328L0 256h22.1l85.507-99.395L175.905 256h74.59L149.073 108.399zM118.81 143.58l-9.909-14.172l-78.84-112.773h33.943l63.625 91.011l9.909 14.173l82.705 118.3H186.3l-67.49-96.533z" />
  </Icon>
);
