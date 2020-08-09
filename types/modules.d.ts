/**
 * Import CSS module files as objects with string values.
 */
declare module '*.module.css' {
    const classes: { [key: string]: string };
    export default classes;
}
/**
 * When importing a PNG file, the imported value is the URL of the image.
 */
declare module '*.png' {
    const imageUrl: string;
    export default imageUrl;
}

/**
 * When importing a JPG file, the imported value is the URL of the image.
 */
declare module '*.jpg' {
    const imageUrl: string;
    export default imageUrl;
}

/**
 * When importing a GIF file, the imported value is the URL of the image.
 */
declare module '*.gif' {
    const imageUrl: string;
    export default imageUrl;
}
