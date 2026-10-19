'use client';

import React, { useState } from 'react';

export interface LogoProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  size?: number;
  className?: string;
}

/**
 * Fallback SVG para Tiny ERP
 */
function TinySvgFallback({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`inline-block shrink-0 ${className}`}
    >
      <rect width="32" height="32" rx="7" fill="url(#tiny-fallback-gradient)" />
      <path d="M7.5 16L13.5 10L19.5 16L13.5 22L7.5 16Z" fill="white" fillOpacity="0.95" />
      <path d="M14.5 9L20.5 15L24.5 11L18.5 5L14.5 9Z" fill="white" fillOpacity="0.75" />
      <path d="M14.5 23L20.5 17L24.5 21L18.5 27L14.5 23Z" fill="white" fillOpacity="0.85" />
      <defs>
        <linearGradient id="tiny-fallback-gradient" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF6B00" />
          <stop offset="1" stopColor="#E64A00" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * Fallback SVG para Banco Inter
 */
function InterSvgFallback({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`inline-block shrink-0 ${className}`}
    >
      <rect width="32" height="32" rx="7" fill="#FF7A00" />
      <g fill="white">
        <circle cx="10" cy="11" r="1.75" />
        <rect x="8.3" y="14.5" width="3.4" height="8.5" rx="1.5" />
        <path
          d="M14.5 17.5C14.5 15.5 16.2 14.5 18.2 14.5C20.8 14.5 22.5 16.2 22.5 19V23H19.5V19.2C19.5 18 18.7 17.2 17.5 17.2C16.3 17.2 15.5 18 15.5 19.2V23H12.5V14.8H14.5V17.5Z"
          fillRule="evenodd"
          clipRule="evenodd"
        />
      </g>
    </svg>
  );
}

/**
 * Fallback SVG para n8n
 */
function N8nSvgFallback({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`inline-block shrink-0 ${className}`}
    >
      <rect width="32" height="32" rx="7" fill="#1A1C23" />
      <g transform="translate(4, 4)">
        <path
          d="M6 12L12 8M12 8L18 12M12 8V16M12 16L6 12M12 16L18 12"
          stroke="#EA4B71"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="6" cy="12" r="3" fill="#FF6D5A" />
        <circle cx="12" cy="8" r="3.2" fill="#EA4B71" />
        <circle cx="18" cy="12" r="3" fill="#FF6D5A" />
        <circle cx="12" cy="16" r="3.2" fill="#EA4B71" />
        <circle cx="12" cy="8" r="1.2" fill="white" />
      </g>
    </svg>
  );
}

/**
 * Fallback SVG para MariaDB
 */
function MariaDbSvgFallback({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`inline-block shrink-0 ${className}`}
    >
      <rect width="32" height="32" rx="7" fill="url(#mariadb-fallback-bg)" />
      <path
        d="M23.5 10C22.2 8.5 20.2 7.8 18.2 8.2C16.8 8.5 15.5 9.4 14.5 10.6C13.2 12.2 12.5 14.2 11.2 15.8C10.2 17 8.8 17.8 7.2 18.2C6.5 18.4 5.8 18.5 5 18.5C5.5 19.5 6.5 20.2 7.8 20.2C9.5 20.2 11.2 19.2 12.5 18C13.8 16.8 14.8 15.2 16.2 14C17.5 12.8 19.2 12.2 21 12.5C21.8 12.6 22.8 13.2 23.5 13.8C24.2 13 24.5 11.8 24.2 10.8C24.1 10.5 23.8 10.2 23.5 10Z"
        fill="#00B4D8"
      />
      <path
        d="M6 23.5C8 22.5 10 22.5 12 23.5C14 24.5 16 24.5 18 23.5C20 22.5 22 22.5 24 23.5C25 24 25.5 24.2 26 24.5"
        stroke="#48CAE4"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="21" cy="9.8" r="0.9" fill="white" />
      <defs>
        <linearGradient id="mariadb-fallback-bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#002B36" />
          <stop offset="1" stopColor="#073642" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * Tiny ERP (Olist) - Logo oficial com imagem corporativa (/imagens/tiny_logo.jpg)
 */
export function TinyLogo({ size = 18, className = '', style, alt = 'Tiny ERP', ...props }: LogoProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <TinySvgFallback size={size} className={className} />;
  }

  return (
    <img
      src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/imagens/tiny_logo.jpg`}
      width={size}
      height={size}
      alt={alt}
      className={`inline-block shrink-0 object-contain rounded-[4px] shadow-sm ${className}`}
      style={{ width: size, height: size, ...style }}
      onError={() => setFailed(true)}
      {...props}
    />
  );
}

/**
 * Banco Inter - Logo oficial com imagem corporativa (/imagens/inter_logo.png)
 */
export function InterLogo({ size = 18, className = '', style, alt = 'Banco Inter', ...props }: LogoProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <InterSvgFallback size={size} className={className} />;
  }

  return (
    <img
      src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/imagens/inter_logo.png`}
      width={size}
      height={size}
      alt={alt}
      className={`inline-block shrink-0 object-contain rounded-[4px] shadow-sm ${className}`}
      style={{ width: size, height: size, ...style }}
      onError={() => setFailed(true)}
      {...props}
    />
  );
}

/**
 * n8n - Logo oficial com imagem corporativa (/imagens/N8n_logo.png)
 */
export function N8nLogo({ size = 18, className = '', style, alt = 'n8n', ...props }: LogoProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <N8nSvgFallback size={size} className={className} />;
  }

  return (
    <img
      src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/imagens/N8n_logo.png`}
      width={size}
      height={size}
      alt={alt}
      className={`inline-block shrink-0 object-contain ${className}`}
      style={{ width: size, height: size, ...style }}
      onError={() => setFailed(true)}
      {...props}
    />
  );
}

/**
 * MariaDB - Logo oficial com imagem corporativa (/imagens/mariadb_logo.png)
 */
export function MariaDbLogo({ size = 18, className = '', style, alt = 'MariaDB', ...props }: LogoProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <MariaDbSvgFallback size={size} className={className} />;
  }

  return (
    <img
      src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/imagens/mariadb_logo.png`}
      width={size}
      height={size}
      alt={alt}
      className={`inline-block shrink-0 object-contain rounded-[4px] shadow-sm ${className}`}
      style={{ width: size, height: size, ...style }}
      onError={() => setFailed(true)}
      {...props}
    />
  );
}

/**
 * Fallback SVG para Google Drive
 */
function GoogleDriveSvgFallback({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`inline-block shrink-0 ${className}`}
    >
      <rect width="32" height="32" rx="7" fill="white" />
      <g transform="translate(4.5, 4.5)">
        <path
          d="M8.2 2L0.6 15.2C0.2 15.9 0 16.7 0 17.5C0 18.3 0.2 19.1 0.6 19.8L2.5 23.1L9.6 10.8L15.3 2H8.2Z"
          fill="#00AC47"
        />
        <path
          d="M15.3 2H8.2L13.8 11.7L21 11.7C21.8 11.7 22.6 11.3 23 10.6L19.2 4.1C18.8 3.4 18.2 2.8 17.5 2.5C16.8 2.2 16.1 2 15.3 2Z"
          fill="#FFBA00"
        />
        <path
          d="M23 10.6L19.2 4.1L9.6 20.7C10 21.4 10.6 22 11.3 22.4C12 22.8 12.8 23 13.6 23H22.1C22.6 23 23 22.6 23 22.1L23 10.6Z"
          fill="#0066DA"
        />
      </g>
    </svg>
  );
}

/**
 * Google Drive API - Logo oficial corporativa (/imagens/Google_Drive_logo.png)
 */
export function GoogleDriveLogo({ size = 18, className = '', style, alt = 'Google Drive', ...props }: LogoProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <GoogleDriveSvgFallback size={size} className={className} />;
  }

  return (
    <img
      src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/imagens/Google_Drive_logo.png`}
      width={size}
      height={size}
      alt={alt}
      className={`inline-block shrink-0 object-contain ${className}`}
      style={{ width: size, height: size, ...style }}
      onError={() => setFailed(true)}
      {...props}
    />
  );
}

/**
 * Componente polimórfico para renderizar qualquer logotipo de serviço suportado
 */
export function BrandLogo({
  name,
  size = 18,
  className = '',
}: {
  name: 'tiny' | 'inter' | 'n8n' | 'mariadb' | 'google-drive' | 'drive' | string;
  size?: number;
  className?: string;
}) {
  const normalized = name.toLowerCase().trim();

  if (normalized.includes('tiny')) {
    return <TinyLogo size={size} className={className} />;
  }
  if (normalized.includes('inter')) {
    return <InterLogo size={size} className={className} />;
  }
  if (normalized.includes('n8n')) {
    return <N8nLogo size={size} className={className} />;
  }
  if (normalized.includes('maria') || normalized.includes('db')) {
    return <MariaDbLogo size={size} className={className} />;
  }
  if (normalized.includes('drive') || normalized.includes('google')) {
    return <GoogleDriveLogo size={size} className={className} />;
  }

  return null;
}
