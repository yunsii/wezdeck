// Motion spec, the JS half (docs/web-pwa.md "Motion"). Values mirror the
// tokens in styles/motion.css so CSS transitions and motion/react agree:
//   state change (hover, press, selected, colour)  CSS transition, short,
//                                                  standard curve
//   element in / out (sticky prompt, chips, …)     motion/react
//                                                  AnimatePresence: enter
//                                                  medium + enter curve,
//                                                  leave exit + exit curve
//   page / pane switch                             View Transitions
//                                                  (lib/view-transition.ts);
//                                                  none inside a wide split
// Same stack as coco-forge (motion 12 + Tailwind 4). LazyMotion with
// domAnimation keeps the cost to the animation features used (`m.*`, not
// `motion.*`); MotionConfig follows the reduced-motion setting (opacity only).
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import type { Transition } from 'motion/react'

/** seconds, as motion takes them — styles/motion.css --motion-* */
export const DURATION = {
  exit: 0.09,
  short: 0.15,
  medium: 0.24,
  long: 0.34,
} as const

/** styles/motion.css --ease-* (Material 3 emphasized curves) */
export const EASE = {
  enter: [0.05, 0.7, 0.1, 1],
  exit: [0.3, 0, 0.8, 0.15],
  standard: [0.2, 0, 0, 1],
} as const

export const ENTER: Transition = { duration: DURATION.medium, ease: EASE.enter }
export const EXIT: Transition = { duration: DURATION.exit, ease: EASE.exit }

/** a small overlay arriving from above (the sticky prompt): drops in 6 px */
export const dropIn = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0, transition: ENTER },
  exit: { opacity: 0, y: -4, transition: EXIT },
} as const

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  )
}
