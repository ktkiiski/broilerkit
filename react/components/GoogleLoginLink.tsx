import * as React from 'react';
import { googleLoginIcon } from './GoogleLoginButton';
import styles from './SocialMediaButton.module.css';

interface GoogleLoginLinkProps {
    className?: string;
    target?: string;
    href: string;
    children: React.ReactNode;
}

export default function GoogleLoginButton({ className, target, href, children }: GoogleLoginLinkProps): JSX.Element {
    return (
        <a
            href={href}
            target={target}
            className={className ? `${styles.googleButton} ${className}` : styles.googleButton}
        >
            {googleLoginIcon}
            <div className={styles.label}>{children}</div>
        </a>
    );
}
