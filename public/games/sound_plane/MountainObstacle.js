class MountainObstacle {
    constructor(canvasWidth, canvasHeight) {
        this.type = 'mountain';
        this.x = canvasWidth;
        this.mountainWidth = Math.random() * 200 + 150;
        
        const minH = canvasHeight * 0.1; // 최소 높이 10%
        const maxH = canvasHeight * 0.75; // 최대 높이 75%
        
        // 이전 산과 차이를 눈에 띄게 주기 위해 높이를 더 크게 무작위화
        const randomFactor = Math.random();
        if (randomFactor < 0.3) {
            this.bottomMountainHeight = minH + Math.random() * (canvasHeight * 0.15); // 낮은 산
        } else if (randomFactor < 0.7) {
            this.bottomMountainHeight = canvasHeight * 0.35 + Math.random() * (canvasHeight * 0.15); // 중간 산
        } else {
            this.bottomMountainHeight = maxH - Math.random() * (canvasHeight * 0.15); // 높은 산
        }
        
        this.topMountainHeight = 0; 
        
        this.passed = false;
        this.width = this.mountainWidth; // For generic scoring logic
    }

    update(speed) {
        this.x -= speed;
    }

    checkCollision(planeCenterX, planeTopY, planeBottomY, planeLeftX, planeRightX, canvasHeight) {
        if (planeCenterX > this.x && planeCenterX < this.x + this.mountainWidth) {
            let bottomCurrentHeight = 0;
            
            if (planeCenterX < this.x + this.mountainWidth / 2) {
                let ratio = (planeCenterX - this.x) / (this.mountainWidth / 2);
                bottomCurrentHeight = this.bottomMountainHeight * ratio;
            } else {
                let ratio = (this.x + this.mountainWidth - planeCenterX) / (this.mountainWidth / 2);
                bottomCurrentHeight = this.bottomMountainHeight * ratio;
            }
            
            if (planeBottomY > canvasHeight - bottomCurrentHeight) {
                return true; 
            }
        }
        return false;
    }

    draw(ctx, canvasHeight) {
        let snowRatio = 0.3; 
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00f2fe';

        const gradientBottom = ctx.createLinearGradient(0, canvasHeight - this.bottomMountainHeight, 0, canvasHeight);
        gradientBottom.addColorStop(0, '#475569');
        gradientBottom.addColorStop(1, '#0f172a');

        ctx.fillStyle = gradientBottom;
        ctx.beginPath();
        ctx.moveTo(this.x, canvasHeight);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(this.x + this.mountainWidth, canvasHeight);
        ctx.fill();
        
        ctx.beginPath();
        let snowHeightB = this.bottomMountainHeight * snowRatio;
        let leftXB = this.x + (this.mountainWidth / 2) * (1 - snowRatio);
        let rightXB = this.x + this.mountainWidth / 2 + (this.mountainWidth / 2) * snowRatio;
        
        ctx.moveTo(leftXB, canvasHeight - this.bottomMountainHeight + snowHeightB);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(rightXB, canvasHeight - this.bottomMountainHeight + snowHeightB);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight + snowHeightB + 10);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(this.x, canvasHeight);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(this.x + this.mountainWidth, canvasHeight);
        ctx.stroke();
    }
}
