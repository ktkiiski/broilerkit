/**
 * When importing a PNG file, the imported value is the URL of the image.
 */
declare module "*.png" {
    const imageUrl: string;
    export = imageUrl;
}

/**
 * When importing a JPG file, the imported value is the URL of the image.
 */
declare module "*.jpg" {
    const imageUrl: string;
    export = imageUrl;
}

/**
 * When importing a GIF file, the imported value is the URL of the image.
 */
declare module "*.gif" {
    const imageUrl: string;
    export = imageUrl;
}
