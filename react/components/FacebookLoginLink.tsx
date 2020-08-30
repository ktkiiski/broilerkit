import * as React from 'react';
import { facebookLoginIcon } from './FacebookLoginButton';
import styles from './SocialMediaButton.module.css';

interface FacebookLoginLinkProps {
    className?: string;
    target?: string;
    href: string;
    children: React.ReactNode;
}

export default function FacebookLoginButton({
    className,
    target,
    href,
    children,
}: FacebookLoginLinkProps): JSX.Element {
    return (
        <a
            href={href}
            target={target}
            className={className ? `${styles.facebookButton} ${className}` : styles.facebookButton}
        >
            {facebookLoginIcon}
            <div className={styles.label}>{children}</div>
        </a>
    );
}
